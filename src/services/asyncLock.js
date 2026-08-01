export class AsyncLock {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}
