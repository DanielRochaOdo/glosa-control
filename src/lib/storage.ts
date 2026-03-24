import type { ImportedDataset, ProcedureGroup } from '../types';

const LEGACY_DATASET_KEY = 'control-glosa:dataset';
const GROUPS_KEY = 'control-glosa:groups';
const DB_NAME = 'control-glosa-db';
const STORE_NAME = 'app-state';
const DATASET_RECORD_KEY = 'current-dataset';

const parseJson = <T,>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const requestToPromise = <T,>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Falha ao acessar o banco local.'));
  });

const transactionToPromise = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Falha ao gravar no banco local.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Gravacao local abortada.'));
  });

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('O navegador nao suporta IndexedDB para armazenar arquivos grandes.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Falha ao abrir o banco local.'));
  });

const loadLegacyDataset = () => parseJson<ImportedDataset | null>(localStorage.getItem(LEGACY_DATASET_KEY), null);

const clearLegacyDataset = () => {
  localStorage.removeItem(LEGACY_DATASET_KEY);
};

const normalizeGroups = (groups: ProcedureGroup[] | unknown): ProcedureGroup[] => {
  if (!Array.isArray(groups)) {
    return [];
  }

  return groups
    .map((group) => {
      if (!group || typeof group !== 'object') {
        return null;
      }

      const currentGroup = group as Record<string, unknown>;
      const rawCodes = Array.isArray(currentGroup.codes) ? currentGroup.codes : [];
      const codes = rawCodes
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }

          if (item && typeof item === 'object' && typeof (item as { code?: unknown }).code === 'string') {
            return (item as { code: string }).code;
          }

          return null;
        })
        .filter((item): item is string => Boolean(item));

      return {
        id: String(currentGroup.id ?? ''),
        name: String(currentGroup.name ?? ''),
        codes,
        cutoffPercentage:
          typeof currentGroup.cutoffPercentage === 'number' ? currentGroup.cutoffPercentage : 50,
        createdAt: String(currentGroup.createdAt ?? new Date().toISOString()),
        updatedAt: String(currentGroup.updatedAt ?? new Date().toISOString()),
      };
    })
    .filter((group): group is ProcedureGroup => Boolean(group?.id));
};

export const loadDataset = async (): Promise<ImportedDataset | null> => {
  const legacyDataset = loadLegacyDataset();

  try {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const indexedDataset = await requestToPromise<ImportedDataset | undefined>(store.get(DATASET_RECORD_KEY));

    if (!indexedDataset && legacyDataset) {
      store.put(legacyDataset, DATASET_RECORD_KEY);
    }

    await transactionToPromise(transaction);
    database.close();
    clearLegacyDataset();

    return indexedDataset ?? legacyDataset;
  } catch {
    return legacyDataset;
  }
};

export const saveDataset = async (dataset: ImportedDataset | null) => {
  clearLegacyDataset();

  try {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    if (dataset) {
      store.put(dataset, DATASET_RECORD_KEY);
    } else {
      store.delete(DATASET_RECORD_KEY);
    }

    await transactionToPromise(transaction);
    database.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao salvar os dados importados.';
    throw new Error(`${message} Os dados continuam visiveis nesta sessao, mas podem nao persistir ao recarregar.`);
  }
};

export const loadGroups = () => normalizeGroups(parseJson<unknown>(localStorage.getItem(GROUPS_KEY), []));

export const saveGroups = (groups: ProcedureGroup[]) => {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(normalizeGroups(groups)));
  } catch {
    throw new Error('Falha ao salvar os grupos no armazenamento local.');
  }
};
