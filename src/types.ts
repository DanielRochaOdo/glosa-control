export type ProcedureRecord = {
  id: string;
  codigoProcedimento: string;
  nomeProcedimento: string;
  nomeDentista: string;
  dataRealizacao: string;
};

export type ImportedDataset = {
  fileName: string;
  importedAt: string;
  competencyMonth: string;
  records: ProcedureRecord[];
  conflicts: ProcedureConflict[];
};

export type ProcedureConflict = {
  codigoProcedimento: string;
  nomesProcedimento: string[];
};

export type ProcedureGroup = {
  id: string;
  name: string;
  codes: string[];
  checkedCodes: string[];
  cutoffPercentage: number;
  isLocked: boolean;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CodeSummary = {
  codigoProcedimento: string;
  nomeProcedimento: string;
  total: number;
};

export type GroupCodeMetrics = {
  codigoProcedimento: string;
  nomeProcedimento: string;
  total: number;
  actualPercentage: number;
};

export type DentistBreakdown = {
  nomeDentista: string;
  total: number;
  codes: {
    codigoProcedimento: string;
    nomeProcedimento: string;
    total: number;
  }[];
};

export type GroupAnalytics = {
  groupTotal: number;
  codes: GroupCodeMetrics[];
  dentists: DentistBreakdown[];
};

export type DentistSnapshotCode = {
  codigoProcedimento: string;
  nomeProcedimento: string;
  total: number;
  actualPercentage: number;
  isChecked: boolean;
};

export type DentistMonthlySnapshot = {
  nomeDentista: string;
  total: number;
  selectedTotal: number;
  selectedPercentage: number;
  isPriority: boolean;
  codes: DentistSnapshotCode[];
};

export type GroupMonthlySnapshot = {
  id: string;
  groupId: string;
  groupName: string;
  competencyMonth: string;
  sourceFileName: string;
  importedAt: string;
  cutoffPercentage: number;
  checkedCodes: string[];
  groupTotal: number;
  codes: GroupCodeMetrics[];
  dentists: DentistMonthlySnapshot[];
  createdAt: string;
  updatedAt: string;
};
