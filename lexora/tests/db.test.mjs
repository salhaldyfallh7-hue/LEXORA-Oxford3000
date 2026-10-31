import assert from 'node:assert/strict';

// Minimal asynchronous IndexedDB test double. This validates the DB module's
// transaction calls and backup semantics; it is not a replacement for testing
// the browser's native IndexedDB implementation on the target device.
class Request {
  constructor(result, delay = 1) {
    this.result = result;
    this.onsuccess = null;
    this.onerror = null;
    setTimeout(() => this.onsuccess?.({ target: this }), delay);
  }
}

class Transaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = Array.isArray(names) ? names : [names];
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.scheduled = false;
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is not in this transaction`);
    if (!this.db.stores.has(name)) throw new Error(`Unknown store ${name}`);
    return new ObjectStore(this, name);
  }
  scheduleComplete() {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => this.oncomplete?.(), 8);
  }
}

class ObjectStore {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  map() { return this.tx.db.stores.get(this.name); }
  put(value) {
    if (this.tx.mode !== 'readwrite') throw new Error('Read-only transaction');
    this.map().set(value.id, structuredClone(value));
    this.tx.scheduleComplete();
    return new Request(value);
  }
  get(key) {
    const result = this.map().has(key) ? structuredClone(this.map().get(key)) : undefined;
    this.tx.scheduleComplete();
    return new Request(result);
  }
  getAll() {
    const result = [...this.map().values()].map(item => structuredClone(item));
    this.tx.scheduleComplete();
    return new Request(result);
  }
  clear() {
    if (this.tx.mode !== 'readwrite') throw new Error('Read-only transaction');
    this.map().clear(); this.tx.scheduleComplete(); return new Request(undefined);
  }
  delete(key) {
    if (this.tx.mode !== 'readwrite') throw new Error('Read-only transaction');
    this.map().delete(key); this.tx.scheduleComplete(); return new Request(undefined);
  }
}

class FakeDB {
  constructor() { this.stores = new Map(); this.objectStoreNames = { contains: name => this.stores.has(name) }; }
  createObjectStore(name) { this.stores.set(name, new Map()); }
  transaction(names, mode = 'readonly') { return new Transaction(this, names, mode); }
}

let database;
globalThis.indexedDB = {
  open(name, version) {
    const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    setTimeout(() => {
      if (!database) {
        database = new FakeDB();
        request.result = database;
        request.onupgradeneeded?.({ target: request });
      } else request.result = database;
      setTimeout(() => request.onsuccess?.({ target: request }), 1);
    }, 1);
    return request;
  }
};

const dbModule = await import('../js/db.js');
const db = await dbModule.openDatabase();
let snapshot = await dbModule.loadUserData(db);
assert.deepEqual(snapshot.meta.unlockedLevels, ['A1']);
assert.equal(snapshot.quizHistory.length, 0);

const progress = { id: 'word-1::A1', wordId: 'word-1', level: 'A1', status: 'mastered', favorite: true };
await dbModule.saveWordProgress(db, progress);
await dbModule.saveMeta(db, { id: 'main', unlockedLevels: ['A1', 'A2'], coverage: {} });
await dbModule.saveQuizResult(db, { id: 'quiz-1', date: new Date().toISOString(), scorePercentage: 90 });
snapshot = await dbModule.loadUserData(db);
assert.equal(snapshot.wordProgress.length, 1);
assert.equal(snapshot.wordProgress[0].favorite, true);
assert.deepEqual(snapshot.meta.unlockedLevels, ['A1', 'A2']);
assert.equal(snapshot.quizHistory.length, 1);

await dbModule.replaceUserData(db, {
  schemaVersion: 1,
  wordProgress: [{ id: 'word-2::A1', wordId: 'word-2', level: 'A1', favorite: false }],
  meta: { unlockedLevels: ['A1'], coverage: {} },
  quizHistory: [{ id: 'quiz-2', date: new Date().toISOString() }]
});
snapshot = await dbModule.loadUserData(db);
assert.equal(snapshot.wordProgress.length, 1);
assert.equal(snapshot.wordProgress[0].wordId, 'word-2');
assert.equal(snapshot.quizHistory[0].id, 'quiz-2');
assert.deepEqual(snapshot.meta.unlockedLevels, ['A1']);

await assert.rejects(
  () => dbModule.replaceUserData(db, { schemaVersion: 9, wordProgress: [], quizHistory: [], meta: {} }),
  /غير صالح/
);
console.log('PASS: IndexedDB module transaction and backup tests (mocked IndexedDB, 11 assertions).');
