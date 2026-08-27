/*
 * storage.js — persistence via IndexedDB.
 *
 * Object stores:
 *   samples  { id, name, type, data (ArrayBuffer), duration }
 *   banks    { id, name, pads[], updatedAt }
 *   projects { id, name, ...settings, pads[], sections[], updatedAt }
 *
 * Audio bytes live once in `samples`; banks and projects reference sample ids.
 * Everything is local to the browser — nothing leaves the machine.
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  const DB_NAME = 'mpc-studio';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not available in this browser context.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('banks')) db.createObjectStore('banks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const Storage = {
    available() {
      return open().then(() => true).catch(() => false);
    },

    /* ---- generic per-store CRUD ---- */
    put(store, value) {
      return tx(store, 'readwrite').then((os) => reqToPromise(os.put(value)));
    },
    get(store, id) {
      return tx(store, 'readonly').then((os) => reqToPromise(os.get(id)));
    },
    delete(store, id) {
      return tx(store, 'readwrite').then((os) => reqToPromise(os.delete(id)));
    },
    all(store) {
      return tx(store, 'readonly').then((os) => reqToPromise(os.getAll()));
    },

    /* ---- samples ---- */
    async saveSample(sample) {
      // sample: { id, name, type, data (ArrayBuffer), duration }
      await this.put('samples', sample);
      return sample.id;
    },
    getSample(id) { return this.get('samples', id); },

    /* ---- banks ---- */
    listBanks() {
      return this.all('banks').then((list) =>
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    },
    saveBank(bank) {
      bank.updatedAt = Date.now();
      return this.put('banks', bank).then(() => bank);
    },
    getBank(id) { return this.get('banks', id); },
    deleteBank(id) { return this.delete('banks', id); },

    /* ---- projects ---- */
    listProjects() {
      return this.all('projects').then((list) =>
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    },
    saveProject(project) {
      project.updatedAt = Date.now();
      return this.put('projects', project).then(() => project);
    },
    getProject(id) { return this.get('projects', id); },
    deleteProject(id) { return this.delete('projects', id); },

    /* ---- housekeeping: drop samples referenced by nothing ---- */
    async pruneSamples() {
      const [samples, banks, projects] = await Promise.all([
        this.all('samples'), this.all('banks'), this.all('projects'),
      ]);
      const used = new Set();
      const collect = (pads) => (pads || []).forEach((p) => { if (p && p.sampleId) used.add(p.sampleId); });
      banks.forEach((b) => collect(b.pads));
      projects.forEach((p) => collect(p.pads));
      let removed = 0;
      for (const s of samples) {
        if (!used.has(s.id)) { await this.delete('samples', s.id); removed++; }
      }
      return removed;
    },

    async estimateUsage() {
      if (navigator.storage && navigator.storage.estimate) {
        try { return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
      }
      return null;
    },
  };

  MPC.storage = Storage;
})();
