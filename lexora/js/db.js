const DB_NAME = 'lexora-oxford3000';
const DB_VERSION = 1;
const STORE_WORDS = 'wordProgress';
const STORE_META = 'appMeta';
const STORE_HISTORY = 'quizHistory';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function openDatabase() {
  if (!('indexedDB' in globalThis)) throw new Error('IndexedDB غير متاح في هذا المتصفح.');
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_WORDS)) db.createObjectStore(STORE_WORDS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
  };
  return requestResult(request);
}

export async function readAll(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return result;
}

export async function readOne(db, storeName, key) {
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return result;
}

export async function writeOne(db, storeName, value) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await transactionDone(tx);
}

export async function removeOne(db, storeName, key) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

export async function loadUserData(db) {
  const [wordProgress, meta, quizHistory] = await Promise.all([
    readAll(db, STORE_WORDS),
    readOne(db, STORE_META, 'main'),
    readAll(db, STORE_HISTORY)
  ]);
  return {
    wordProgress,
    meta: meta || {
      id: 'main',
      unlockedLevels: ['A1'],
      coverage: {},
      lastVisited: { section: 'home', level: 'A1', wordId: null },
      createdAt: new Date().toISOString()
    },
    quizHistory: quizHistory.sort((a, b) => new Date(b.date) - new Date(a.date))
  };
}

export async function saveWordProgress(db, value) {
  await writeOne(db, STORE_WORDS, value);
}

export async function saveMeta(db, value) {
  await writeOne(db, STORE_META, { ...value, id: 'main' });
}

export async function saveQuizResult(db, value) {
  await writeOne(db, STORE_HISTORY, value);
}

export async function replaceUserData(db, backup) {
  if (!backup || backup.schemaVersion !== 1 || !Array.isArray(backup.wordProgress) || !Array.isArray(backup.quizHistory) || !backup.meta) {
    throw new Error('ملف النسخة الاحتياطية غير صالح أو من إصدار غير مدعوم.');
  }
  const tx = db.transaction([STORE_WORDS, STORE_META, STORE_HISTORY], 'readwrite');
  const words = tx.objectStore(STORE_WORDS);
  const meta = tx.objectStore(STORE_META);
  const history = tx.objectStore(STORE_HISTORY);
  words.clear();
  history.clear();
  backup.wordProgress.forEach(item => words.put(item));
  historyItems(backup.quizHistory).forEach(item => history.put(item));
  meta.put({ ...backup.meta, id: 'main' });
  await transactionDone(tx);
}

function historyItems(items) {
  return items.filter(item => item && typeof item.id === 'string');
}
