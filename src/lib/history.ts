import type { GroupMonthlySnapshot, ProcedureGroup } from '../types';
import { getSupabaseClient } from './supabase';

const SNAPSHOTS_KEY = 'control-glosa:monthly-snapshots';

type SnapshotRow = {
  id: string;
  group_id: string;
  group_name: string;
  competency_month: string;
  source_file_name: string;
  imported_at: string;
  cutoff_percentage: number;
  checked_codes: string[];
  group_total: number;
  codes_payload: GroupMonthlySnapshot['codes'];
  dentists_payload: GroupMonthlySnapshot['dentists'];
  created_at: string;
  updated_at: string;
};

type GroupRow = {
  group_id: string;
  name: string;
  codes: string[];
  checked_codes: string[];
  cutoff_percentage: number;
  is_locked: boolean;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
};

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

const mapRowToSnapshot = (row: SnapshotRow): GroupMonthlySnapshot => ({
  id: row.id,
  groupId: row.group_id,
  groupName: row.group_name,
  competencyMonth: row.competency_month.slice(0, 7),
  sourceFileName: row.source_file_name,
  importedAt: row.imported_at,
  cutoffPercentage: Number(row.cutoff_percentage ?? 0),
  checkedCodes: Array.isArray(row.checked_codes) ? row.checked_codes : [],
  groupTotal: Number(row.group_total ?? 0),
  codes: Array.isArray(row.codes_payload) ? row.codes_payload : [],
  dentists: Array.isArray(row.dentists_payload) ? row.dentists_payload : [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapSnapshotToRow = (snapshot: GroupMonthlySnapshot): SnapshotRow => ({
  id: snapshot.id,
  group_id: snapshot.groupId,
  group_name: snapshot.groupName,
  competency_month: `${snapshot.competencyMonth}-01`,
  source_file_name: snapshot.sourceFileName,
  imported_at: snapshot.importedAt,
  cutoff_percentage: snapshot.cutoffPercentage,
  checked_codes: snapshot.checkedCodes,
  group_total: snapshot.groupTotal,
  codes_payload: snapshot.codes,
  dentists_payload: snapshot.dentists,
  created_at: snapshot.createdAt,
  updated_at: snapshot.updatedAt,
});

const snapshotKey = (snapshot: Pick<GroupMonthlySnapshot, 'groupId' | 'competencyMonth'>) =>
  `${snapshot.groupId}:${snapshot.competencyMonth}`;

const normalizeSnapshot = (value: unknown): GroupMonthlySnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as Partial<GroupMonthlySnapshot>;
  const competencyMonth =
    typeof row.competencyMonth === 'string' && /^\d{4}-\d{2}$/.test(row.competencyMonth)
      ? row.competencyMonth
      : null;

  if (
    typeof row.id !== 'string' ||
    typeof row.groupId !== 'string' ||
    typeof row.groupName !== 'string' ||
    competencyMonth === null
  ) {
    return null;
  }

  return {
    id: row.id,
    groupId: row.groupId,
    groupName: row.groupName,
    competencyMonth,
    sourceFileName: typeof row.sourceFileName === 'string' ? row.sourceFileName : 'arquivo',
    importedAt: typeof row.importedAt === 'string' ? row.importedAt : new Date().toISOString(),
    cutoffPercentage: typeof row.cutoffPercentage === 'number' ? row.cutoffPercentage : 50,
    checkedCodes:
      Array.isArray(row.checkedCodes) && row.checkedCodes.every((item) => typeof item === 'string')
        ? row.checkedCodes
        : [],
    groupTotal: typeof row.groupTotal === 'number' ? row.groupTotal : 0,
    codes: Array.isArray(row.codes) ? row.codes : [],
    dentists: Array.isArray(row.dentists) ? row.dentists : [],
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
  };
};

const loadLocalSnapshots = (): GroupMonthlySnapshot[] =>
  parseJson<unknown[]>(localStorage.getItem(SNAPSHOTS_KEY), [])
    .map((item) => normalizeSnapshot(item))
    .filter((item): item is GroupMonthlySnapshot => Boolean(item))
    .sort((a, b) => a.competencyMonth.localeCompare(b.competencyMonth));

const saveLocalSnapshots = (snapshots: GroupMonthlySnapshot[]) => {
  localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots));
};

export const loadSnapshotsByGroup = async (groupId: string): Promise<GroupMonthlySnapshot[]> => {
  const localSnapshots = loadLocalSnapshots().filter((snapshot) => snapshot.groupId === groupId);
  const supabase = getSupabaseClient();

  if (!supabase) {
    return localSnapshots;
  }

  const { data, error } = await supabase
    .from('group_report_snapshots')
    .select(
      'id, group_id, group_name, competency_month, source_file_name, imported_at, cutoff_percentage, checked_codes, group_total, codes_payload, dentists_payload, created_at, updated_at',
    )
    .eq('group_id', groupId)
    .order('competency_month', { ascending: true });

  if (error) {
    throw new Error(`Falha ao carregar historico mensal: ${error.message}`);
  }

  const merged = new Map<string, GroupMonthlySnapshot>();
  localSnapshots.forEach((snapshot) => merged.set(snapshotKey(snapshot), snapshot));
  (data ?? []).map((row) => mapRowToSnapshot(row as SnapshotRow)).forEach((snapshot) => {
    merged.set(snapshotKey(snapshot), snapshot);
  });

  const nextSnapshots = Array.from(merged.values()).sort((a, b) =>
    a.competencyMonth.localeCompare(b.competencyMonth),
  );
  saveLocalSnapshots(loadLocalSnapshots().filter((item) => item.groupId !== groupId).concat(nextSnapshots));

  return nextSnapshots;
};

export const saveMonthlySnapshot = async (snapshot: GroupMonthlySnapshot) => {
  const localSnapshots = loadLocalSnapshots();
  const merged = new Map<string, GroupMonthlySnapshot>();
  localSnapshots.forEach((item) => merged.set(snapshotKey(item), item));
  merged.set(snapshotKey(snapshot), snapshot);
  saveLocalSnapshots(Array.from(merged.values()).sort((a, b) => a.competencyMonth.localeCompare(b.competencyMonth)));

  const supabase = getSupabaseClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase
    .from('group_report_snapshots')
    .upsert(mapSnapshotToRow(snapshot), { onConflict: 'group_id,competency_month' });

  if (error) {
    throw new Error(`Falha ao salvar historico mensal no Supabase: ${error.message}`);
  }
};

export const loadRemoteGroups = async (): Promise<ProcedureGroup[]> => {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from('procedure_groups')
    .select(
      'group_id, name, codes, checked_codes, cutoff_percentage, is_locked, locked_at, created_at, updated_at',
    );

  if (error) {
    throw new Error(`Falha ao carregar grupos do Supabase: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const value = row as GroupRow;

    return {
      id: value.group_id,
      name: value.name,
      codes: Array.isArray(value.codes) ? value.codes : [],
      checkedCodes: Array.isArray(value.checked_codes) ? value.checked_codes : [],
      cutoffPercentage: Number(value.cutoff_percentage ?? 50),
      isLocked: Boolean(value.is_locked),
      lockedAt: value.locked_at,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    };
  });
};

export const syncGroupToCloud = async (group: ProcedureGroup) => {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.from('procedure_groups').upsert(
    {
      group_id: group.id,
      name: group.name,
      codes: group.codes,
      checked_codes: group.checkedCodes.filter((code) => group.codes.includes(code)),
      cutoff_percentage: group.cutoffPercentage,
      is_locked: group.isLocked,
      locked_at: group.lockedAt,
      created_at: group.createdAt,
      updated_at: group.updatedAt,
    },
    { onConflict: 'group_id' },
  );

  if (error) {
    throw new Error(`Falha ao sincronizar grupo no Supabase: ${error.message}`);
  }
};

export const deleteGroupFromCloud = async (groupId: string) => {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.from('procedure_groups').delete().eq('group_id', groupId);

  if (error) {
    throw new Error(`Falha ao remover grupo no Supabase: ${error.message}`);
  }
};
