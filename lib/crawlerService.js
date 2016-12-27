const Q = require('q');

class CrawlerService {
  constructor(crawler, options) {
    this.crawler = crawler;
    this.options = options;
    this.loops = [];
  }

  ensureInitialized() {
    // deferred initialization of the options and crawler.  When they are available, swap them in and listen for changes
    if (typeof this.crawler.then !== 'function') {
      return Q();
    }
    return this.crawler.then(([crawler, options]) => {
      this.options = options;
      this.options._emitter.on('changed', this._reconfigure.bind(this));
      this.crawler = crawler;
    });
  }

  run() {
    return this.ensureInitialized().then(() => {
      return this.ensureLoops();
    });
  }

  _loopComplete(loop) {
    console.log(`Done loop ${loop.options.name}`);
  }

  ensureLoops() {
    this.loops = this.loops.filter(loop => loop.running());
    const running = this.status();
    const delta = this.options.count - running;
    if (delta < 0) {
      for (let i = 0; i < Math.abs(delta); i++) {
        const loop = this.loops.shift();
        loop.stop();
      }
    } else {
      for (let i = 0; i < delta; i++) {
        const loop = new CrawlerLoop(this.crawler, i.toString());
        loop.run().finally(this._loopComplete.bind(this, loop));
        this.loops.push(loop);
      }
    }
    return Q();
  }

  status() {
    return this.loops.reduce((running, loop) => {
      return running + (loop.running ? 1 : 0);
    }, 0);
  }

  stop() {
    return this.ensureLoops();
  }

  queues() {
    return this.crawler.queues;
  }

  _reconfigure(current, changes) {
    // if the loop count changed, make it so
    if (changes.some(patch => patch.path === '/count')) {
      return this.options.count && this.options.count.value > 0 ? this.run() : this.stop();
    }
    return null;
  }

  _collectPatches(patches) {
    return patches.reduce((result, patch) => {
      const segments = patch.path.split('/');
      const key = segments[1];
      result[key] = result[key] || [];
      patch.path = '/' + segments.slice(2).join('/');
      result[key].push(patch);
      return result;
    }, {});
  }
}

class CrawlerLoop {
  constructor(crawler, name) {
    this.crawler = crawler;
    this.options = { name: name, delay: 0 };
    this.done = null;
    this.state = null;
  }

  running() {
    return this.state === 'running';
  }

  run() {
    if (this.state) {
      throw new Error(`Loop ${this.options.name} can only be run once`);
    }
    this.state = 'running';
    // Create callback that when run, resolves a promise and completes this loop
    const doneDeferred = Q.defer();
    this.done = value => doneDeferred.resolve(value);
    this.options.done = this.done;
    const donePromise = doneDeferred.promise;
    donePromise.finally(() => {
      this.state = 'stopped';
    });

    // Kick off the loop and don't worry about the return value.
    // donePromise will be resolved when the loop is complete.
    this.crawler.run(this.options);
    return donePromise;
  }

  stop() {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }
    this.state = 'stopping';
    // set delay to tell the loop to stop next time around
    // TODO consider explicitly waking sleeping loops but they will check whether they
    // should keep running when they wake up.
    this.options.delay = -1;
  }
}

module.exports = CrawlerService;