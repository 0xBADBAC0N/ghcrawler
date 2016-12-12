const moment = require('moment');
const Processor = require('./processor');
const Q = require('q');
const Request = require('./request');
const URL = require('url');

class Crawler {

  constructor(queues, store, locker, fetcher, options) {
    this.queues = queues;
    this.store = store;
    this.locker = locker;
    this.fetcher = fetcher;
    this.options = options;
    this.logger = options.logger;
    this.processor = new Processor();
  }

  run(context) {
    if (context.delay === -1) {
      // We are done so call the done handler and return without continuing the loop
      return context.done ? context.done() : null;
    }
    const delay = context.currentDelay;
    context.currentDelay = 0;
    if (delay) {
      this.logger.verbose(`Crawler: ${context.name} waiting for ${delay}ms`);
    }
    setTimeout(() => { this._run(context); }, delay);
  }

  _run(context) {
    try {
      // if this loop got cancelled while sleeping, exit
      if (context.delay === -1) {
        return context.done ? context.done() : null;
      }
      return Q.try(() => this.processOne(context))
        .then(this.log(this._computeDelay.bind(this, context)), this._panic.bind(this, context))
        .finally(this.log(this.run.bind(this, context)));
    } catch (error) {
      // If for some reason we throw all the way out of start, log and restart the loop
      this._panic(context, error);
      this.run(context);
    }
  }

  _panic(context, error) {
    this.logger.error(new Error('PANIC, we should not have gotten here'));
    this.logger.error(error);
  }

  _computeDelay(context, request) {
    let delay = context.delay;
    if (delay === -1) {
      return delay;
    }
    delay = delay || 0;
    const now = Date.now();
    const contextGate = now + delay;
    const requestGate = request.nextRequestTime || now;
    const nextRequestTime = Math.max(contextGate, requestGate, now);
    delay = Math.max(0, nextRequestTime - now);
    context.currentDelay = delay;
    return delay;
  }

  /**
   * Process one request cycle.  If an error happens during processing, handle it there and
   * return a spec describing any delays that should be in .
   */
  processOne(context) {
    let requestBox = [];

    return Q()
      .then(this.log(this._getRequest.bind(this, requestBox, context)))
      .then(this.log(this._filter.bind(this)))
      .then(this.log(this._fetch.bind(this)))
      .then(this.log(this._convertToDocument.bind(this)))
      .then(this.log(this._processDocument.bind(this)))
      .then(this.log(this._storeDocument.bind(this)))
      .catch(this.log(this._errorHandler.bind(this, requestBox)))
      .then(this.log(this._completeRequest.bind(this), this._completeRequest.bind(this)))
      .catch(this.log(this._errorHandler.bind(this, requestBox)))
      .then(this.log(this._logOutcome.bind(this)))
      .catch(this.log(this._errorHandler.bind(this, requestBox)));
  }

  _errorHandler(requestBox, error) {
    if (requestBox[0]) {
      if (requestBox[0].type === '_errorTrap') {
        // TODO if there is a subsequent error, just capture the first and carry on for now.  likely should log
        return requestBox[0];
      } else {
        return requestBox[0].markRequeue('Error', error);
      }
    }
    const request = new Request('_errorTrap', null);
    request.delay();
    request.markSkip('Error', error);
    requestBox[0] = request;
    return request;
  }

  _getRequest(requestBox, context) {
    return this._logStartEnd('getRequest', null, () => { return this._getRequestWork(requestBox, context); });
  }

  _getRequestWork(requestBox, context) {
    const self = this;
    return this.log(this.queues.pop(), 'pop')
      .then(request => {
        if (!request) {
          request = new Request('_blank', null);
          request.delay(self.options.pollingDelay || 2000);
          request.markSkip('Exhausted queue', `Waiting 2 seconds`);
        }
        request.start = Date.now();
        request.crawler = self;
        request.loopName = context.name;
        requestBox[0] = request;
        request.context = request.context || {};
        request.promises = [];
        return request;
      })
      .then(self.log(self._acquireLock.bind(self)));
  }

  _acquireLock(request) {
    if (!request.url || !this.locker) {
      return Q(request);
    }
    const self = this;
    return Q.try(() => {
      return this.log(self.locker.lock(request.url, self.options.processingTtl || 60 * 1000), 'lock');
    }).then(
      lock => {
        request.lock = lock;
        return request;
      },
      error => {
        // If we could not acquire a lock, requeue.  If the "error" is a normal Exceeded scenario, requeue normally
        // noting that we could not get a lock.  For any other error, requeue and capture the error for debugging.
        if (error.message.startsWith('Exceeded')) {
          return request.markRequeue('Requeued', 'Could not lock');
        }
        return request.markRequeue('Error', error);
      });
  }

  _releaseLock(request) {
    if (!request.lock || !this.locker) {
      return Q(request);
    }
    const self = this;
    return Q.try(() => {
      return this.locker.unlock(request.lock);
    }).then(
      () => {
        request.lock = null;
        return request;
      },
      error => {
        request.lock = null;
        self.logger.error(error);
        return request;
      });
  }

  _completeRequest(request, forceRequeue = false) {
    // There are two paths through here, happy and sad.  The happy path requeues the request (if needed),
    // waits for all the promises to finish and then releases the lock on the URL and deletes the request
    // from the queue.  However, if requeuing fails we should still release the lock but NOT delete the
    // request from the queue (we were not able to put it back on so leave it there to expire and be
    // redelivered).  In the sad case we don't really need to wait for the promises as we are already going
    // to reprocess the request.
    // Unfortunately, this may result in a buildup of requests being processed over and over and not counted
    // (attemptCount will not be updated in the queuing system).  Since the requeue issue is likely something
    // to do with queuing in general, the theory is that the queue system's retry count will deadletter the
    // request eventually.
    //
    // Basic workflow
    // requeue
    //    if error, log, release and abandon (don't bother to wait for promises as we were requeuing any way')
    // wait for promises
    //    if error, try requeue
    //    else release
    //      if release fails abandon as everyone will think it is still in the queue
    //      else delete

    const self = this;
    if (forceRequeue || (request.shouldRequeue() && request.url)) {
      return Q
        .try(() => { return self._requeue(request); })
        .catch(error => { self.logger.error(error); throw error; })
        .finally(() => self._releaseLock(request))
        .then(() => self._deleteFromQueue(request), error => self._abandonInQueue(request))
        .then(() => request);
    }
    const completeWork = Q.all(request.promises).then(
      () => self._releaseLock(request).then(
        () => self._deleteFromQueue(request),
        error => self._abandonInQueue(request)),
      error => self._completeRequest(request, true));
    return completeWork.then(() => request);
  }

  _requeue(request) {
    return Q.try(() => {
      request.attemptCount = request.attemptCount || 0;
      if (++request.attemptCount > 5) {
        this.logger.warn(`Exceeded attempt count for ${request.type}@${request.url}`);
        return this._queueDead(request);
      }
      request.addMeta({ attempt: request.attemptCount });
      this.logger.info(`Requeuing attempt ${request.attemptCount} of request ${request.type}@${request.url}`);
      const queuable = this._createQueuable(request);
      return this.queues.repush(request, queuable);
    });
  }

  _filter(request) {
    if (!request.url || !request.type) {
      this._queueDead(request);
      return request.markSkip('Error', new Error(`Detected malformed request ${request.toString()}`));
    }
    if (!this._shouldInclude(request.type, request.url)) {
      request.markSkip('Filtered');
    }
    return request;
  }

  _fetch(request) {
    if (request.shouldSkip()) {
      return request;
    }
    return this._logStartEnd('fetching', request, () => {
      return this.fetcher.fetch(request);
    });
  }

  _convertToDocument(request) {
    if (request.shouldSkip()) {
      return Q(request);
    }

    const metadata = {
      type: request.type,
      url: request.url,
      fetchedAt: moment.utc().toISOString(),
      links: {}
    };
    if (request.response && request.response.headers) {
      if (request.response.headers.etag) {
        metadata.etag = request.response.headers.etag;
      }
      if (request.response.headers.link) {
        metadata.headers = { link: request.response.headers.link };
      }
    }
    // overlay any metadata that we might be carrying from a version of this doc that we already have
    Object.assign(metadata, request.response._metadataTemplate);

    // If the doc is an array,
    // * wrap it in an object to make storage more consistent (Mongo can't store arrays directly)
    // * save the link header as GitHub will not return those in a subsequent 304
    if (Array.isArray(request.document)) {
      request.document = { elements: request.document };
    }
    request.document._metadata = metadata;
    return Q(request);
  }

  _processDocument(request) {
    if (request.shouldSkip()) {
      return Q(request);
    }
    return this._logStartEnd('processing', request, () => {
      request.document = this.processor.process(request);
      return request;
    });
  }

  _logStartEnd(name, request, work) {
    const start = Date.now();
    let uniqueString = request ? request.toUniqueString() : '';
    this.logger.verbose(`Started ${name} ${uniqueString}`);
    let result = null;
    return Q
      .try(() => { return work(); })
      .then(workResult => {
        result = workResult;
        return result;
      })
      .finally(() => {
        // in the getRequest case we did not have a request to start.  Report on the one we found.
        if (!request && result instanceof Request) {
          uniqueString = result.toUniqueString();
        } else if (uniqueString === '') {
          console.log('what?!');
        }
        this.logger.verbose(`Finished ${name} (${Date.now() - start}ms) ${uniqueString}`);
      });
  }

  _storeDocument(request) {
    if (request.shouldSkip() || !request.shouldSave()) {
      return Q(request);
    }

    const start = Date.now();
    return this.store.upsert(request.document).then(upsert => {
      request.upsert = upsert;
      request.addMeta({ store: Date.now() - start });
      return request;
    });
  }

  _deleteFromQueue(request) {
    return Q.try(() => {
      return this.queues.done(request).then(() => { return request; });
    });
  }

  _abandonInQueue(request) {
    return Q.try(() => {
      return this.queues.abandon(request).then(() => { return request; });
    });
  }

  _logOutcome(request) {
    const outcome = request.outcome ? request.outcome : 'Processed';
    if (outcome === 'Error') {
      const error = (request.message instanceof Error) ? request.message : new Error(request.message);
      error._type = request.type;
      error._url = request.url;
      this.logger.error(error);
    } else {
      request.addMeta({ time: Date.now() - request.start });
      const policy = request.policy.getShortForm();
      this.logger.info(`${outcome} ${policy} ${request.type}@${request.url} ${request.message || ''}`, request.meta);
    }
    return request;
  }

  // ===============  Helpers  ============

  _queueDead(request) {
    const queuable = this._createQueuable(request);
    return this.queues.pushDead(queuable);
  }

  queue(request, name = 'normal') {
    if (!request.url || !request.type) {
      this._queueDead(request);
      throw new Error(`Attempt to queue malformed request ${request.toString()}`);
    }
    if (!this._shouldInclude(request.type, request.url)) {
      this.logger.verbose(`Filtered ${request.type}@${request.url}`);
      return [];
    }
    const queuable = this._createQueuable(request);
    return this.queues.push(queuable, name);
  }

  _createQueuable(request) {
    // Create a new request data structure that has just the things we should queue
    const queuable = new Request(request.type, request.url, request.context);
    queuable.attemptCount = request.attemptCount;
    queuable.policy = request.policy;
    return queuable;
  }

  _shouldInclude(type, target) {
    if (!this.options.orgList || this.options.orgList.length === 0) {
      return true;
    }
    if (type === 'repo' || type === 'repos' || type === 'org') {
      const parsed = URL.parse(target);
      const org = parsed.path.split('/')[2];
      return this.options.orgList.includes(org.toLowerCase());
    }
    return true;
  }

  // don't mess with the funky method signature formatting.  You need spaces around the
  // istanbul comment for istanbul to pick it up but auto code formatting removes the spaces
  // before the (.  Putting a newline seems to keep everyone happy.
  log /* istanbul ignore next */
    (thing) {
    if (!this.options.promiseTrace) {
      return thing;
    }
    const self = this;
    if (typeof thing === 'function') {
      return function () {
        const args = array_slice(arguments);
        const name = thing.name.replace('bound ', '');
        self.logger.verbose(`Promise Function Enter: ${name}`);
        const result = thing.apply(self, args);
        if (typeof result.then === 'function') {
          result.then(
            result => { self.logger.silly(`Promise Function Success: ${name}`); },
            error => { self.logger.silly(`Promise Function Error: ${name}`, error); });
        } else {
          self.logger.verbose(`Promise Function Exit: ${name}: ${result}`);
        }
        return result;
      };
    } else if (typeof thing.then === 'function') {
      this.logger.silly(`Promise Enter`);
      thing.then(
        result => { this.logger.silly(`Promise Success: ${result}`); },
        error => { this.logger.silly(`Promise Error: ${error.message}`, error); });
      return thing;
    }
  }
}

module.exports = Crawler;

/* istanbul ignore next */
let call = Function.call;
/* istanbul ignore next */
function uncurryThis(f) {
  return function () {
    return call.apply(f, arguments);
  };
}
// This is equivalent, but slower:
// uncurryThis = Function_bind.bind(Function_bind.call);
// http://jsperf.com/uncurrythis


/* istanbul ignore next */
let array_slice = uncurryThis(Array.prototype.slice);

