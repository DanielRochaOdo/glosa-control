import { ChangeEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeGroup, summarizeCodes } from './lib/analytics';
import { deleteGroupFromCloud, loadRemoteGroups, loadSnapshotsByGroup, saveMonthlySnapshot, syncGroupToCloud } from './lib/history';
import { parseUploadedFile } from './lib/parser';
import { loadDataset, loadGroups, saveDataset, saveGroups } from './lib/storage';
import type {
  CodeSummary,
  DentistBreakdown,
  GroupMonthlySnapshot,
  ImportedDataset,
  ProcedureGroup,
} from './types';

const formatPercent = (value: number) =>
  new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const formatDate = (isoDate: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(isoDate));

const formatMonth = (value: string) => {
  const [year, month] = value.split('-');

  if (!year || !month) {
    return value;
  }

  return `${month}/${year}`;
};

const getCurrentMonth = () => new Date().toISOString().slice(0, 7);

const normalizeMonthValue = (value: string) => (/^\d{4}-\d{2}$/.test(value) ? value : getCurrentMonth());

const extractMonthFromDate = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(/^(\d{4})-(\d{2})-\d{2}$/);
  return match ? `${match[1]}-${match[2]}` : null;
};

const getDatasetCompetencyMonth = (dataset: ImportedDataset) => {
  if (/^\d{4}-\d{2}$/.test(dataset.competencyMonth)) {
    return dataset.competencyMonth;
  }

  const months = Array.from(
    new Set(
      dataset.records
        .map((record) => extractMonthFromDate(record.dataRealizacao))
        .filter((month): month is string => Boolean(month)),
    ),
  );

  if (months.length === 1) {
    return months[0];
  }

  return normalizeMonthValue(dataset.importedAt.slice(0, 7));
};

const sanitizePercentage = (value: string) => {
  const parsed = Number.parseFloat(value);

  if (Number.isNaN(parsed)) {
    return 0;
  }

  return Math.min(100, Math.max(0, parsed));
};

const slugId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const loadThemePreference = () => {
  if (typeof window === 'undefined') {
    return 'light';
  }

  return window.localStorage.getItem('control-glosa:theme') === 'dark' ? 'dark' : 'light';
};

const normalizeGroup = (group: ProcedureGroup): ProcedureGroup => {
  const normalizedCodes = Array.from(new Set(group.codes));
  const normalizedCheckedCodes = Array.from(
    new Set(group.checkedCodes.filter((code) => normalizedCodes.includes(code))),
  );

  return {
    ...group,
    codes: normalizedCodes,
    checkedCodes: normalizedCheckedCodes,
  };
};

const mergeLocalAndRemoteGroups = (localGroups: ProcedureGroup[], remoteGroups: ProcedureGroup[]) => {
  const merged = new Map<string, ProcedureGroup>();

  localGroups.forEach((group) => merged.set(group.id, normalizeGroup(group)));

  remoteGroups.forEach((remoteGroup) => {
    const current = merged.get(remoteGroup.id);

    if (!current) {
      merged.set(remoteGroup.id, normalizeGroup(remoteGroup));
      return;
    }

    const currentUpdated = new Date(current.updatedAt).getTime();
    const remoteUpdated = new Date(remoteGroup.updatedAt).getTime();
    merged.set(remoteGroup.id, normalizeGroup(remoteUpdated >= currentUpdated ? remoteGroup : current));
  });

  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
};

const makeSnapshotId = (groupId: string, competencyMonth: string) => `${groupId}:${competencyMonth}`;

type PrioritizedDentist = DentistBreakdown & {
  selectedTotal: number;
  selectedPercentage: number;
  isPriority: boolean;
};

type RecurringMonthDetail = {
  month: string;
  selectedTotal: number;
  total: number;
  selectedPercentage: number;
  checkedCodes: {
    codigoProcedimento: string;
    nomeProcedimento: string;
    total: number;
    actualPercentage: number;
  }[];
};

type RecurringDentistDetail = {
  nomeDentista: string;
  months: number;
  details: RecurringMonthDetail[];
};

const prioritizeDentists = (
  dentists: DentistBreakdown[],
  highlightedCodes: string[],
  cutoffPercentage: number,
) => {
  const selectedCodeSet = new Set(highlightedCodes);

  return dentists
    .map((dentist) => {
      const selectedTotal = dentist.codes.reduce(
        (sum, code) => sum + (selectedCodeSet.has(code.codigoProcedimento) ? code.total : 0),
        0,
      );
      const selectedPercentage = dentist.total > 0 ? (selectedTotal / dentist.total) * 100 : 0;
      const isPriority = selectedCodeSet.size > 0 && selectedPercentage >= cutoffPercentage;

      return {
        ...dentist,
        selectedTotal,
        selectedPercentage,
        isPriority,
      };
    })
    .sort((a, b) => {
      if (a.isPriority !== b.isPriority) {
        return a.isPriority ? -1 : 1;
      }

      if (b.selectedPercentage !== a.selectedPercentage) {
        return b.selectedPercentage - a.selectedPercentage;
      }

      if (b.total !== a.total) {
        return b.total - a.total;
      }

      return a.nomeDentista.localeCompare(b.nomeDentista, 'pt-BR');
    });
};

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(loadThemePreference);
  const [dataset, setDataset] = useState<ImportedDataset | null>(null);
  const [groups, setGroups] = useState<ProcedureGroup[]>(() => loadGroups());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(() => loadGroups()[0]?.id ?? null);
  const [view, setView] = useState<'dashboard' | 'charts'>('dashboard');
  const [reportMonth, setReportMonth] = useState(getCurrentMonth);
  const [chartGroupId, setChartGroupId] = useState<string | null>(null);
  const [groupSnapshots, setGroupSnapshots] = useState<GroupMonthlySnapshot[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [createCodeQuery, setCreateCodeQuery] = useState('');
  const [editCodeQuery, setEditCodeQuery] = useState('');
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isRestoringDataset, setIsRestoringDataset] = useState(true);
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [expandedDentists, setExpandedDentists] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [chartFeedback, setChartFeedback] = useState<string | null>(null);
  const [reportFeedback, setReportFeedback] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const deferredCreateCodeQuery = useDeferredValue(createCodeQuery);
  const deferredEditCodeQuery = useDeferredValue(editCodeQuery);

  useEffect(() => {
    let isMounted = true;

    const restoreDataset = async () => {
      try {
        const storedDataset = await loadDataset();

        if (isMounted) {
          setDataset(storedDataset);
          setStorageMessage(null);
        }
      } catch (error) {
        if (isMounted) {
          setStorageMessage(error instanceof Error ? error.message : 'Falha ao restaurar os dados locais.');
        }
      } finally {
        if (isMounted) {
          setIsRestoringDataset(false);
        }
      }
    };

    void restoreDataset();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const restoreCloudGroups = async () => {
      try {
        const remoteGroups = await loadRemoteGroups();

        if (!isMounted || remoteGroups.length === 0) {
          return;
        }

        setGroups((current) => mergeLocalAndRemoteGroups(current, remoteGroups));
        setStorageMessage(null);
      } catch (error) {
        if (isMounted) {
          setStorageMessage(error instanceof Error ? error.message : 'Falha ao carregar grupos no Supabase.');
        }
      }
    };

    void restoreCloudGroups();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    try {
      saveGroups(groups.map((group) => normalizeGroup(group)));
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao salvar os grupos localmente.');
    }

    const syncGroups = async () => {
      try {
        await Promise.all(groups.map((group) => syncGroupToCloud(normalizeGroup(group))));
      } catch (error) {
        setStorageMessage(error instanceof Error ? error.message : 'Falha ao sincronizar grupos no Supabase.');
      }
    };

    void syncGroups();
  }, [groups]);

  useEffect(() => {
    if (isRestoringDataset) {
      return;
    }

    const persistDataset = async () => {
      try {
        await saveDataset(dataset);
        setStorageMessage(null);
      } catch (error) {
        setStorageMessage(error instanceof Error ? error.message : 'Falha ao salvar os dados importados.');
      }
    };

    void persistDataset();
  }, [dataset, isRestoringDataset]);

  useEffect(() => {
    if (!dataset) {
      setReportMonth(getCurrentMonth());
      return;
    }

    setReportMonth(getDatasetCompetencyMonth(dataset));
  }, [dataset]);

  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupId) {
        setSelectedGroupId(null);
      }
      return;
    }

    if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(groups[0].id);
    }
  }, [groups, selectedGroupId]);

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem('control-glosa:theme', theme);
  }, [theme]);

  const codeSummary: CodeSummary[] = useMemo(
    () => (dataset ? summarizeCodes(dataset.records) : []),
    [dataset],
  );
  const codeSummaryMap = useMemo(
    () => new Map(codeSummary.map((code) => [code.codigoProcedimento, code])),
    [codeSummary],
  );
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );
  const datasetCompetencyMonth = useMemo(
    () => (dataset ? getDatasetCompetencyMonth(dataset) : null),
    [dataset],
  );
  const checkedGroupCodes = selectedGroup?.checkedCodes ?? [];
  const analytics = useMemo(
    () => (selectedGroup && dataset ? analyzeGroup(selectedGroup, dataset.records) : null),
    [selectedGroup, dataset],
  );
  const totalDentists = useMemo(
    () => (dataset ? new Set(dataset.records.map((record) => record.nomeDentista)).size : 0),
    [dataset],
  );
  const prioritizedDentists = useMemo(
    () =>
      analytics && selectedGroup
        ? prioritizeDentists(analytics.dentists, checkedGroupCodes, selectedGroup.cutoffPercentage)
        : [],
    [analytics, checkedGroupCodes, selectedGroup],
  );
  const priorityDentistCount = useMemo(
    () => prioritizedDentists.filter((dentist) => dentist.isPriority).length,
    [prioritizedDentists],
  );

  useEffect(() => {
    setIsEditingGroupName(false);
    setEditingGroupName(selectedGroup?.name ?? '');
    setExpandedDentists([]);
  }, [selectedGroup?.id, selectedGroup?.name]);

  const createSuggestions = useMemo(
    () =>
      codeSummary
        .filter((code) => {
          const text = `${code.codigoProcedimento} ${code.nomeProcedimento}`.toLowerCase();
          return (
            !selectedCodes.includes(code.codigoProcedimento) &&
            (!deferredCreateCodeQuery.trim() || text.includes(deferredCreateCodeQuery.toLowerCase()))
          );
        })
        .slice(0, 16),
    [codeSummary, deferredCreateCodeQuery, selectedCodes],
  );

  const selectedCodeItems = useMemo(
    () =>
      selectedCodes
        .map((code) => codeSummaryMap.get(code))
        .filter((item): item is CodeSummary => Boolean(item)),
    [codeSummaryMap, selectedCodes],
  );

  const availableCodesToAdd = useMemo(
    () => codeSummary.filter((summary) => !selectedGroup?.codes.includes(summary.codigoProcedimento)),
    [codeSummary, selectedGroup],
  );

  const editSuggestions = useMemo(
    () =>
      availableCodesToAdd.filter((code) => {
        const text = `${code.codigoProcedimento} ${code.nomeProcedimento}`.toLowerCase();
        return !deferredEditCodeQuery.trim() || text.includes(deferredEditCodeQuery.toLowerCase());
      }),
    [availableCodesToAdd, deferredEditCodeQuery],
  );

  const resetCreator = () => {
    setGroupName('');
    setSelectedCodes([]);
    setCreateCodeQuery('');
  };

  const selectGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
    setReportFeedback(null);

    if (dataset) {
      setReportMonth(getDatasetCompetencyMonth(dataset));
    }
  };

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setIsImporting(true);
    setFeedback(null);
    setReportFeedback(null);
    setErrorMessage(null);
    setStorageMessage(null);

    try {
      const parsed = await parseUploadedFile(file);
      setDataset(parsed);
      setFeedback(
        `${parsed.records.length} registros importados de ${parsed.fileName}. Competencia detectada: ${formatMonth(parsed.competencyMonth)}.`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao importar arquivo.');
    } finally {
      setIsImporting(false);
      event.target.value = '';
    }
  };

  const addCodeToCreateSelection = (code: string) => {
    setSelectedCodes((current) => (current.includes(code) ? current : [...current, code]));
    setCreateCodeQuery('');
  };

  const removeCodeFromCreateSelection = (code: string) => {
    setSelectedCodes((current) => current.filter((item) => item !== code));
  };

  const toggleCheckedGroupCode = (groupId: string, code: string) => {
    updateGroup(groupId, (group) => ({
      ...group,
      checkedCodes: group.checkedCodes.includes(code)
        ? group.checkedCodes.filter((item) => item !== code)
        : [...group.checkedCodes, code],
    }));
  };

  const createGroup = () => {
    if (!dataset) {
      setErrorMessage('Importe um arquivo antes de criar grupos.');
      return;
    }

    if (!groupName.trim()) {
      setErrorMessage('Defina um nome para o grupo.');
      return;
    }

    if (selectedCodes.length === 0) {
      setErrorMessage('Selecione pelo menos um codigo para o grupo.');
      return;
    }

    const newGroup: ProcedureGroup = {
      id: slugId(),
      name: groupName.trim(),
      codes: selectedCodes,
      checkedCodes: [],
      cutoffPercentage: 50,
      isLocked: false,
      lockedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const nextGroups = [newGroup, ...groups];
    setGroups(nextGroups);
    setSelectedGroupId(newGroup.id);
    setFeedback(`Grupo "${newGroup.name}" criado com ${newGroup.codes.length} codigos.`);
    setErrorMessage(null);
    resetCreator();
  };

  const updateGroup = (groupId: string, updater: (group: ProcedureGroup) => ProcedureGroup) => {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? normalizeGroup({
              ...updater(group),
              updatedAt: new Date().toISOString(),
            })
          : group,
      ),
    );
  };

  const addCodeToGroup = (groupId: string, code: string) => {
    const group = groups.find((item) => item.id === groupId);

    if (!group || group.isLocked) {
      setErrorMessage('Destrave o grupo para adicionar codigos.');
      return;
    }

    updateGroup(groupId, (group) => ({
      ...group,
      codes: [...group.codes, code],
    }));
    setEditCodeQuery('');
  };

  const deleteGroup = async (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    const nextGroups = groups.filter((item) => item.id !== groupId);
    setGroups(nextGroups);
    setSelectedGroupId(nextGroups[0]?.id ?? null);
    setGroupSnapshots((current) => current.filter((snapshot) => snapshot.groupId !== groupId));

    try {
      await deleteGroupFromCloud(groupId);
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao remover grupo no Supabase.');
    }

    setFeedback(group ? `Grupo "${group.name}" removido.` : 'Grupo removido.');
  };

  const toggleGroupLock = (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);

    if (!group) {
      return;
    }

    const now = new Date().toISOString();
    updateGroup(groupId, (current) => ({
      ...current,
      isLocked: !current.isLocked,
      lockedAt: current.isLocked ? null : now,
    }));
    setFeedback(group.isLocked ? `Grupo "${group.name}" destravado.` : `Grupo "${group.name}" travado.`);
    setErrorMessage(null);
  };

  const openGroupCharts = async (groupId: string) => {
    selectGroup(groupId);
    setChartGroupId(groupId);
    setView('charts');
    setIsLoadingSnapshots(true);
    setChartFeedback(null);
    setStorageMessage(null);

    try {
      const snapshots = await loadSnapshotsByGroup(groupId);
      setGroupSnapshots(snapshots);
      setErrorMessage(null);
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao carregar historico mensal.');
      setGroupSnapshots([]);
    } finally {
      setIsLoadingSnapshots(false);
    }
  };

  const saveMonthlyGroupReport = async (group: ProcedureGroup) => {
    if (!dataset) {
      setReportFeedback(null);
      setErrorMessage('Importe um arquivo antes de adicionar a competencia ao relatorio mensal.');
      return;
    }

    setReportFeedback(null);
    const currentGroup = groups.find((item) => item.id === group.id) ?? group;
    const competencyMonth = getDatasetCompetencyMonth(dataset);
    const now = new Date().toISOString();
    const currentAnalytics = analyzeGroup(currentGroup, dataset.records);
    const selectedDentists = prioritizeDentists(
      currentAnalytics.dentists,
      currentGroup.checkedCodes,
      currentGroup.cutoffPercentage,
    );
    const lockedGroup = normalizeGroup({
      ...currentGroup,
      isLocked: true,
      lockedAt: currentGroup.lockedAt ?? now,
      updatedAt: now,
    });

    setGroups((current) =>
      current.map((item) => (item.id === currentGroup.id ? lockedGroup : item)),
    );

    const snapshot: GroupMonthlySnapshot = {
      id: makeSnapshotId(currentGroup.id, competencyMonth),
      groupId: currentGroup.id,
      groupName: currentGroup.name,
      competencyMonth,
      sourceFileName: dataset.fileName,
      importedAt: dataset.importedAt,
      cutoffPercentage: currentGroup.cutoffPercentage,
      checkedCodes: currentGroup.checkedCodes,
      groupTotal: currentAnalytics.groupTotal,
      codes: currentAnalytics.codes,
      dentists: selectedDentists.map((dentist) => ({
        nomeDentista: dentist.nomeDentista,
        total: dentist.total,
        selectedTotal: dentist.selectedTotal,
        selectedPercentage: dentist.selectedPercentage,
        isPriority: dentist.isPriority,
        codes: dentist.codes.map((code) => ({
          codigoProcedimento: code.codigoProcedimento,
          nomeProcedimento: code.nomeProcedimento,
          total: code.total,
          actualPercentage: dentist.total > 0 ? (code.total / dentist.total) * 100 : 0,
          isChecked: currentGroup.checkedCodes.includes(code.codigoProcedimento),
        })),
      })),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await syncGroupToCloud(lockedGroup);
      await saveMonthlySnapshot(snapshot);
      const successMessage = `Competencia ${formatMonth(competencyMonth)} adicionada ao grupo "${currentGroup.name}" com sucesso.`;

      if (view === 'charts' && chartGroupId === currentGroup.id) {
        const snapshots = await loadSnapshotsByGroup(currentGroup.id);
        setGroupSnapshots(snapshots);
        setChartFeedback(successMessage);
      } else {
        setChartFeedback(null);
      }
      setReportFeedback(successMessage);

      setFeedback(
        `Relatorio de ${formatMonth(competencyMonth)} salvo e grupo "${currentGroup.name}" travado para comparativos.`,
      );
      setErrorMessage(null);
      setStorageMessage(null);
    } catch (error) {
      setChartFeedback(null);
      setReportFeedback(null);
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao salvar historico mensal.');
    }
  };

  const chartGroup = useMemo(
    () => groups.find((group) => group.id === chartGroupId) ?? null,
    [chartGroupId, groups],
  );
  const maxMonthlyTotal = useMemo(
    () => Math.max(1, ...groupSnapshots.map((snapshot) => snapshot.groupTotal)),
    [groupSnapshots],
  );
  const checkedCodesForCharts = useMemo(() => {
    const codeMap = new Map<string, string>();

    groupSnapshots.forEach((snapshot) => {
      snapshot.codes.forEach((code) => {
        if (snapshot.checkedCodes.includes(code.codigoProcedimento)) {
          codeMap.set(code.codigoProcedimento, code.nomeProcedimento);
        }
      });
    });

    return Array.from(codeMap.entries()).map(([codigoProcedimento, nomeProcedimento]) => ({
      codigoProcedimento,
      nomeProcedimento,
    }));
  }, [groupSnapshots]);
  const codeMonthSeries = useMemo(
    () =>
      checkedCodesForCharts.map((checkedCode) => {
        const series = groupSnapshots.map((snapshot) => {
          const code = snapshot.codes.find(
            (item) => item.codigoProcedimento === checkedCode.codigoProcedimento,
          );

          return {
            month: snapshot.competencyMonth,
            total: code?.total ?? 0,
            percentage: code?.actualPercentage ?? 0,
          };
        });

        return {
          ...checkedCode,
          maxTotal: Math.max(1, ...series.map((item) => item.total)),
          series,
        };
      }),
    [checkedCodesForCharts, groupSnapshots],
  );
  const priorityDentistSeries = useMemo(
    () =>
      groupSnapshots.map((snapshot) => ({
        month: snapshot.competencyMonth,
        total: snapshot.dentists.filter((dentist) => dentist.isPriority).length,
      })),
    [groupSnapshots],
  );
  const maxPriorityDentists = useMemo(
    () => Math.max(1, ...priorityDentistSeries.map((item) => item.total)),
    [priorityDentistSeries],
  );
  const recurringDentists = useMemo(() => {
    const dentistMap = new Map<string, Map<string, RecurringMonthDetail>>();

    groupSnapshots.forEach((snapshot) => {
      snapshot.dentists
        .filter((dentist) => dentist.isPriority)
        .forEach((dentist) => {
          const checkedCodes = dentist.codes
            .filter((code) => code.isChecked && code.total > 0)
            .map((code) => ({
              codigoProcedimento: code.codigoProcedimento,
              nomeProcedimento: code.nomeProcedimento,
              total: code.total,
              actualPercentage: code.actualPercentage,
            }))
            .sort((a, b) => b.total - a.total);
          const detailsByMonth = dentistMap.get(dentist.nomeDentista) ?? new Map<string, RecurringMonthDetail>();

          detailsByMonth.set(snapshot.competencyMonth, {
            month: snapshot.competencyMonth,
            selectedTotal: dentist.selectedTotal,
            total: dentist.total,
            selectedPercentage: dentist.selectedPercentage,
            checkedCodes,
          });
          dentistMap.set(dentist.nomeDentista, detailsByMonth);
        });
    });

    return Array.from(dentistMap.entries())
      .map(([nomeDentista, detailsByMonth]): RecurringDentistDetail => {
        const details = Array.from(detailsByMonth.values()).sort((a, b) => a.month.localeCompare(b.month));

        return {
          nomeDentista,
          months: details.length,
          details,
        };
      })
      .filter((dentist) => dentist.months > 1)
      .sort((a, b) => {
        if (b.months !== a.months) {
          return b.months - a.months;
        }

        return a.nomeDentista.localeCompare(b.nomeDentista, 'pt-BR');
      });
  }, [groupSnapshots]);

  const toggleDentistExpansion = (dentistName: string) => {
    setExpandedDentists((current) =>
      current.includes(dentistName)
        ? current.filter((item) => item !== dentistName)
        : [...current, dentistName],
    );
  };

  const clearImportedData = async () => {
    const groupIds = groups.map((group) => group.id);

    setDataset(null);
    setGroups([]);
    setGroupSnapshots([]);
    setSelectedGroupId(null);
    setChartGroupId(null);
    setView('dashboard');
    setSelectedCodes([]);
    setGroupName('');
    setCreateCodeQuery('');
    setEditCodeQuery('');
    setIsEditingGroupName(false);
    setEditingGroupName('');
    setFeedback('Dados importados removidos com sucesso.');
    setReportFeedback(null);
    setErrorMessage(null);
    setStorageMessage(null);
    setIsConfirmDeleteOpen(false);

    try {
      await Promise.all(groupIds.map((groupId) => deleteGroupFromCloud(groupId)));
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao limpar grupos no Supabase.');
    }
  };

  const saveGroupName = () => {
    if (!selectedGroup) {
      return;
    }

    if (selectedGroup.isLocked) {
      setErrorMessage('Grupo travado. Destrave para editar o nome.');
      return;
    }

    if (!editingGroupName.trim()) {
      setErrorMessage('Defina um nome para o grupo.');
      return;
    }

    updateGroup(selectedGroup.id, (group) => ({
      ...group,
      name: editingGroupName.trim(),
    }));
    setIsEditingGroupName(false);
    setErrorMessage(null);
  };

  const startEditingGroup = (group: ProcedureGroup) => {
    if (group.isLocked) {
      setErrorMessage('Grupo travado. Destrave para editar.');
      return;
    }

    setSelectedGroupId(group.id);
    setEditingGroupName(group.name);
    setIsEditingGroupName(true);
  };

  const exportGroupData = async (onlyRecurringDentists = false) => {
    if (!selectedGroup || !analytics) {
      setErrorMessage('Selecione um grupo com dados para exportar.');
      return;
    }

    const prioritizedDentistsForPdf = prioritizeDentists(
      analytics.dentists,
      checkedGroupCodes,
      selectedGroup.cutoffPercentage,
    );
    const recurringDentistNames = new Set(recurringDentists.map((dentist) => dentist.nomeDentista));
    const dentistsForPdf = onlyRecurringDentists
      ? prioritizedDentistsForPdf.filter((dentist) => recurringDentistNames.has(dentist.nomeDentista))
      : prioritizedDentistsForPdf;

    if (onlyRecurringDentists && dentistsForPdf.length === 0) {
      setErrorMessage('Nao ha dentistas com recorrencia para exportar neste relatorio.');
      return;
    }

    const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
    const autoTable = autoTableModule.default;
    const safeGroupName = selectedGroup.name.trim() || 'grupo';
    const doc = new jsPDF({
      unit: 'pt',
      format: 'a4',
    });
    const docWithTable = doc as typeof doc & { lastAutoTable?: { finalY: number } };
    const pageWidth = doc.internal.pageSize.getWidth();
    const exportDate = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());

    doc.setFillColor(111, 165, 126);
    doc.roundedRect(40, 36, pageWidth - 80, 72, 14, 14, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Relatorio do grupo', 56, 64);
    doc.setFontSize(14);
    doc.text(safeGroupName, 56, 86);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Exportado em ${exportDate}`, pageWidth - 56, 64, { align: 'right' });
    doc.text(`Corte: ${formatPercent(selectedGroup.cutoffPercentage)}%`, pageWidth - 56, 82, { align: 'right' });
    doc.text(`Total de ocorrencias: ${analytics.groupTotal}`, pageWidth - 56, 100, { align: 'right' });

    doc.setTextColor(35, 49, 39);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Resumo', 40, 138);

    autoTable(doc, {
      startY: 150,
      head: [['Grupo', 'Codigos', 'Ocorrencias', 'Corte percentual']],
      body: [[safeGroupName, String(selectedGroup.codes.length), String(analytics.groupTotal), `${formatPercent(selectedGroup.cutoffPercentage)}%`]],
      theme: 'grid',
      headStyles: { fillColor: [111, 165, 126], textColor: [255, 255, 255], fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: [35, 49, 39] },
      margin: { left: 40, right: 40 },
      styles: { cellPadding: 6, lineColor: [209, 225, 214], lineWidth: 0.6 },
    });

    autoTable(doc, {
      startY: docWithTable.lastAutoTable?.finalY ? docWithTable.lastAutoTable.finalY + 18 : 210,
      head: [['Codigo', 'Procedimento', 'Total', '% real', 'Acima do corte']],
      body: analytics.codes.map((code) => [
        code.codigoProcedimento,
        code.nomeProcedimento,
        String(code.total),
        `${formatPercent(code.actualPercentage)}%`,
        code.actualPercentage >= selectedGroup.cutoffPercentage ? 'Sim' : 'Nao',
      ]),
      theme: 'grid',
      headStyles: { fillColor: [159, 206, 170], textColor: [35, 49, 39], fontSize: 9 },
      bodyStyles: { fontSize: 8, textColor: [35, 49, 39] },
      alternateRowStyles: { fillColor: [247, 251, 247] },
      margin: { left: 40, right: 40 },
      styles: { cellPadding: 5, lineColor: [209, 225, 214], lineWidth: 0.6 },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { cellWidth: 250 },
        2: { cellWidth: 55, halign: 'right' },
        3: { cellWidth: 55, halign: 'right' },
        4: { cellWidth: 75, halign: 'center' },
      },
    });

    autoTable(doc, {
      startY: docWithTable.lastAutoTable?.finalY ? docWithTable.lastAutoTable.finalY + 18 : 360,
      head: [['Dentista', 'Codigo', 'Procedimento', 'Total', '%']],
      body: dentistsForPdf.flatMap((dentist) => {
        const dentistStyles = dentist.isPriority
          ? { textColor: [154, 60, 71] as [number, number, number], fontStyle: 'bold' as const }
          : {};

        return dentist.codes.map((code, index) => {
          const codePercentage = dentist.total > 0 ? (code.total / dentist.total) * 100 : 0;

          return [
            ...(index === 0
              ? [
                  {
                    content: dentist.nomeDentista,
                    rowSpan: dentist.codes.length,
                    styles: {
                      valign: 'middle' as const,
                      ...dentistStyles,
                    },
                  },
                ]
              : []),
            {
              content: code.codigoProcedimento,
              styles: dentistStyles,
            },
            {
              content: code.nomeProcedimento,
              styles: dentistStyles,
            },
            {
              content: String(code.total),
              styles: {
                halign: 'right' as const,
                ...dentistStyles,
              },
            },
            {
              content: `${formatPercent(codePercentage)}%`,
              styles: {
                halign: 'right' as const,
                ...dentistStyles,
              },
            },
          ];
        });
      }),
      theme: 'grid',
      headStyles: { fillColor: [223, 240, 227], textColor: [35, 49, 39], fontSize: 9 },
      bodyStyles: { fontSize: 8, textColor: [35, 49, 39] },
      alternateRowStyles: { fillColor: [250, 253, 250] },
      margin: { left: 40, right: 40, bottom: 32 },
      styles: { cellPadding: 5, lineColor: [209, 225, 214], lineWidth: 0.6 },
      columnStyles: {
        0: { cellWidth: 110 },
        1: { cellWidth: 70 },
        2: { cellWidth: 170 },
        3: { cellWidth: 45, halign: 'right' },
        4: { cellWidth: 55, halign: 'right' },
      },
      didDrawPage: (data) => {
        const pageNumber = doc.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(110, 124, 114);
        doc.text(`Pagina ${pageNumber}`, data.settings.margin.left, doc.internal.pageSize.getHeight() - 14);
      },
    });

    doc.save(`${safeGroupName.replace(/[^\w-]+/g, '_')}.pdf`);
    setFeedback(
      onlyRecurringDentists
        ? `Exportacao em PDF do grupo "${safeGroupName}" concluida (somente dentistas com recorrencia).`
        : `Exportacao em PDF do grupo "${safeGroupName}" concluida.`,
    );
    setErrorMessage(null);
  };

  return (
    <div className="app-shell">
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-top-row">
            <span className="eyebrow">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <path
                  d="M16 8h20l12 12v28c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V16c0-4.4 3.6-8 8-8Z"
                  fill="currentColor"
                  opacity="0.16"
                />
                <path
                  d="M36 8v12h12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M24 36c0-5.5 4.5-10 10-10s10 4.5 10 10s-4.5 10-10 10s-10-4.5-10-10Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  d="m41 43 7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
                <path
                  d="M16 8h20l12 12v28c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V16c0-4.4 3.6-8 8-8Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinejoin="round"
                />
              </svg>
              Auditoria de Procedimentos
            </span>
            <button
              type="button"
              className="theme-toggle"
              aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
              title={theme === 'light' ? 'Tema escuro' : 'Tema claro'}
              onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            >
              {theme === 'light' ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 3v2.2M12 18.8V21M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M3 12h2.2M18.8 12H21M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6M12 7.2a4.8 4.8 0 1 0 0 9.6a4.8 4.8 0 0 0 0-9.6Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M20 14.5A8.5 8.5 0 0 1 9.5 4A8.8 8.8 0 1 0 20 14.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
          <h1>Painel de auditoria de procedimentos</h1>
          <p>Importe a planilha, monte grupos por codigo e acompanhe pesos, recorrencia por dentistas.</p>
        </div>

        <div className="upload-card glass-card">
          <div className="panel-title-row">
            <div>
              <h2>Importacao</h2>
              <p className="subtle-text">CSV ou XLSX</p>
            </div>
            <div className="upload-status-actions">
              <span className="status-badge">
                {isRestoringDataset ? 'Restaurando dados...' : isImporting ? 'Lendo arquivo...' : 'Pronto'}
              </span>
              <button
                type="button"
                className="danger-button icon-button small-button upload-clear-button"
                onClick={() => setIsConfirmDeleteOpen(true)}
                disabled={!dataset && groups.length === 0}
                aria-label="Limpar dados importados"
                title="Limpar dados importados"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="m14.5 4 5.5 5.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="m13 5.5 5.5 5.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="m12 7 4.5 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="m4 15.5 6.5-6.5 4 4L8 19.5H4v-4Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4.5 20h8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M17.25 15.25v2.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <path
                    d="M16 16.5h2.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <path
                    d="M19.25 11.75v1.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M18.5 12.5H20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          <div className="upload-box compact-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileImport}
              disabled={isImporting}
            />
            <div className="upload-callout">
              <div>
                <strong>Selecionar arquivo</strong>
              </div>
              <button
                type="button"
                className="primary-button small-button inline-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
              >
                Escolher arquivo
              </button>
            </div>
          </div>

          {feedback ? <p className="feedback success">{feedback}</p> : null}
          {errorMessage ? <p className="feedback error">{errorMessage}</p> : null}
          {storageMessage ? <p className="feedback warning">{storageMessage}</p> : null}

          {dataset ? (
            <p className="meta-line">
              Arquivo atual: <strong>{dataset.fileName}</strong> em {formatDate(dataset.importedAt)}
            </p>
          ) : null}
        </div>
      </header>

      <main className="dashboard">
        {view === 'charts' ? (
          <section className="glass-card compact-card charts-screen">
            <div className="detail-header">
              <div className="section-heading">
                <h2>Comparativo mensal</h2>
                <p>
                  {chartGroup ? `Grupo: ${chartGroup.name}` : 'Selecione um grupo para ver o historico mensal.'}
                </p>
              </div>
              <div className="detail-actions">
                {chartGroup && dataset ? (
                  <button
                    type="button"
                    className="primary-button small-button inline-primary"
                    onClick={() => void saveMonthlyGroupReport(chartGroup)}
                  >
                    Adicionar ao relatorio ({formatMonth(datasetCompetencyMonth ?? reportMonth)})
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost-button small-button"
                  onClick={() => void exportGroupData(true)}
                  disabled={!selectedGroup || !analytics}
                  title={!selectedGroup || !analytics ? 'Importe um arquivo para exportar o PDF.' : 'Exportar PDF'}
                >
                  Exportar PDF
                </button>
                <button type="button" className="ghost-button small-button" onClick={() => setView('dashboard')}>
                  Voltar
                </button>
              </div>
            </div>

            {isLoadingSnapshots ? <p className="feedback warning">Carregando historico mensal...</p> : null}
            {chartFeedback ? <p className="feedback success">{chartFeedback}</p> : null}

            {!isLoadingSnapshots && chartGroup && groupSnapshots.length === 0 ? (
              <p className="empty-state compact-empty">
                Nenhum relatorio mensal salvo para este grupo. Use "Adicionar ao relatorio" para incluir o mes atual.
              </p>
            ) : null}

            {!isLoadingSnapshots && chartGroup && groupSnapshots.length > 0 ? (
              <div className="charts-layout">
                <article className="inner-card compact-inner-card">
                  <h3>Total do grupo por mes</h3>
                  <div className="bar-list">
                    {groupSnapshots.map((snapshot) => (
                      <div key={snapshot.id} className="bar-item">
                        <div className="bar-labels">
                          <strong>{formatMonth(snapshot.competencyMonth)}</strong>
                          <strong>{snapshot.groupTotal}</strong>
                        </div>
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${Math.min((snapshot.groupTotal / maxMonthlyTotal) * 100, 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="inner-card compact-inner-card">
                  <h3>Codigos marcados por mes</h3>
                  {codeMonthSeries.length ? (
                    <div className="monthly-code-grid">
                      {codeMonthSeries.map((series) => (
                        <div key={series.codigoProcedimento} className="code-month-card">
                          <div className="panel-title-row">
                            <strong>{series.codigoProcedimento}</strong>
                            <span>{series.nomeProcedimento}</span>
                          </div>
                          <div className="bar-list">
                            {series.series.map((item) => (
                              <div key={`${series.codigoProcedimento}-${item.month}`} className="bar-item">
                                <div className="bar-labels">
                                  <span>{formatMonth(item.month)}</span>
                                  <strong>
                                    {item.total}x ({formatPercent(item.percentage)}%)
                                  </strong>
                                </div>
                                <div className="bar-track">
                                  <div
                                    className="bar-fill"
                                    style={{ width: `${Math.min((item.total / series.maxTotal) * 100, 100)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state compact-empty">
                      Nenhum checkbox marcado nos relatorios salvos deste grupo.
                    </p>
                  )}
                </article>

                <article className="inner-card compact-inner-card">
                  <h3>Dentistas em nao conformidade por mes</h3>
                  <div className="bar-list">
                    {priorityDentistSeries.map((item) => (
                      <div key={item.month} className="bar-item">
                        <div className="bar-labels">
                          <span>{formatMonth(item.month)}</span>
                          <strong>{item.total}</strong>
                        </div>
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${Math.min((item.total / maxPriorityDentists) * 100, 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="inner-card compact-inner-card">
                  <h3>Recorrencia de dentistas</h3>
                  {recurringDentists.length ? (
                    <div className="table-list compact-table-list">
                      {recurringDentists.map((dentist) => (
                        <div key={dentist.nomeDentista} className="dentist-card recurring-dentist-toggle expanded">
                          <div className="dentist-header">
                            <strong>{dentist.nomeDentista}</strong>
                            <span>Nao conformidade recorrente</span>
                          </div>
                          <div className="row-stats compact-stats">
                            <strong>{dentist.months}</strong>
                            <span>meses</span>
                          </div>
                          <div className="dentist-details recurring-dentist-details">
                            {dentist.details.map((detail) => (
                              <div key={`${dentist.nomeDentista}-${detail.month}`} className="recurring-month-item">
                                <div className="recurring-month-header">
                                  <strong>{formatMonth(detail.month)}</strong>
                                  <span>
                                    {detail.selectedTotal}/{detail.total} marcados ({formatPercent(detail.selectedPercentage)}
                                    %)
                                  </span>
                                </div>
                                {detail.checkedCodes.length ? (
                                  <div className="dentist-codes recurring-codes">
                                    {detail.checkedCodes.map((code) => (
                                      <div
                                        key={`${dentist.nomeDentista}-${detail.month}-${code.codigoProcedimento}`}
                                        className="dentist-code highlighted"
                                      >
                                        <span>{code.codigoProcedimento}</span>
                                        <span>
                                          {code.total}x - {formatPercent(code.actualPercentage)}%
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="empty-state compact-empty">
                                    Sem ocorrencias de codigos marcados neste mes.
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state compact-empty">
                      Ainda nao ha recorrencia em meses diferentes para dentistas em nao conformidade.
                    </p>
                  )}
                </article>
              </div>
            ) : null}
          </section>
        ) : (
          <>
        <section className="metrics-grid compact-grid">
          <article className="metric-card glass-card">
            <span className="metric-label">Procedimentos</span>
            <strong>{dataset?.records.length ?? 0}</strong>
          </article>
          <article className="metric-card glass-card">
            <span className="metric-label">Codigos unicos</span>
            <strong>{codeSummary.length}</strong>
          </article>
          <article className="metric-card glass-card">
            <span className="metric-label">Dentistas</span>
            <strong>{totalDentists}</strong>
          </article>
          <article className="metric-card glass-card">
            <span className="metric-label">Conflitos</span>
            <strong>{dataset?.conflicts.length ?? 0}</strong>
          </article>
        </section>

        {dataset?.conflicts.length ? (
          <section className="glass-card alert-card compact-card">
            <div className="section-heading">
              <h2>Conflitos de nome por codigo</h2>
              <p>Revise a origem dos dados quando o mesmo codigo tiver mais de um nome.</p>
            </div>
            <div className="conflict-list compact-list">
              {dataset.conflicts.map((conflict) => (
                <div key={conflict.codigoProcedimento} className="conflict-item">
                  <strong>{conflict.codigoProcedimento}</strong>
                  <span>{conflict.nomesProcedimento.join(' | ')}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="workspace-grid compact-workspace">
          <aside className="glass-card sidebar compact-card">
            <div className="section-heading">
              <h2>Criar novo grupo</h2>
              <p>Use a busca para localizar codigos e adicionar varios pela sugestao.</p>
            </div>

            <div className="field">
              <label htmlFor="groupName">Nome do grupo</label>
              <input
                id="groupName"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Ex.: Clinico"
              />
            </div>

            <div className="field">
              <label htmlFor="createCodeQuery">Buscar codigo</label>
              <input
                id="createCodeQuery"
                value={createCodeQuery}
                onChange={(event) => setCreateCodeQuery(event.target.value)}
                placeholder="Digite parte do codigo ou procedimento"
              />
            </div>

            <div className="suggestion-panel">
              {createSuggestions.length ? (
                createSuggestions.map((code) => (
                  <button
                    key={code.codigoProcedimento}
                    type="button"
                    className="suggestion-item"
                    onClick={() => addCodeToCreateSelection(code.codigoProcedimento)}
                  >
                    <strong>{code.codigoProcedimento}</strong>
                    <span>{code.nomeProcedimento}</span>
                  </button>
                ))
              ) : (
                <p className="empty-state compact-empty">
                  {createCodeQuery ? 'Nenhum codigo encontrado.' : 'Todos os codigos ja foram selecionados.'}
                </p>
              )}
            </div>

            <div className="selector-summary">
              <span>{selectedCodes.length} codigos selecionados</span>
              <button type="button" className="ghost-button small-button" onClick={resetCreator}>
                Limpar
              </button>
            </div>

            <div className="chip-list">
              {selectedCodeItems.length ? (
                selectedCodeItems.map((code) => (
                  <button
                    key={code.codigoProcedimento}
                    type="button"
                    className="selection-chip"
                    onClick={() => removeCodeFromCreateSelection(code.codigoProcedimento)}
                  >
                    <span>{code.codigoProcedimento}</span>
                    <small>remover</small>
                  </button>
                ))
              ) : (
                <p className="empty-state compact-empty">Nenhum codigo selecionado.</p>
              )}
            </div>

            <button type="button" className="primary-button" onClick={createGroup}>
              Criar grupo
            </button>
          </aside>

          <section className="content-column">
            <div className="glass-card groups-card compact-card">
              <div className="section-heading">
                <h2>Grupos cadastrados</h2>
                <p>Selecione um grupo para editar pesos e ver a distribuicao.</p>
              </div>

              <div className="group-list compact-list">
                {groups.length ? (
                  groups.map((group) => (
                    <div key={group.id} className={`group-item-row ${group.id === selectedGroupId ? 'active' : ''}`}>
                      <button
                        type="button"
                        className={`group-tab ${group.id === selectedGroupId ? 'active' : ''}`}
                        onClick={() => selectGroup(group.id)}
                      >
                        <span>{group.name}</span>
                      </button>
                      <div className="group-item-meta">
                        <button
                          type="button"
                          className="icon-button small-button group-edit-button"
                          aria-label={`Editar grupo ${group.name}`}
                          onClick={() => startEditingGroup(group)}
                          disabled={group.isLocked}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M4 20h4l10.5-10.5a1.4 1.4 0 0 0 0-2L16.5 5a1.4 1.4 0 0 0-2 0L4 15.5V20Z"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="icon-button small-button group-chart-button"
                          aria-label={`Abrir grafico do grupo ${group.name}`}
                          onClick={() => void openGroupCharts(group.id)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M4 19.5h16M7 16V9.5M12 16V6.5M17 16v-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={`icon-button small-button ${group.isLocked ? 'group-lock-button locked' : 'group-lock-button unlocked'}`}
                          aria-label={`${group.isLocked ? 'Destravar' : 'Travar'} grupo ${group.name}`}
                          onClick={() => toggleGroupLock(group.id)}
                        >
                          {group.isLocked ? (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                d="M7.5 10V7.2a4.5 4.5 0 0 1 9 0V10m-11 0h13v10h-13V10Z"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                d="M16.5 10V7.2a4.5 4.5 0 0 0-9 0m-2 2.8h13v10h-13V10Z"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button small-button group-delete-button"
                          aria-label={`Excluir grupo ${group.name}`}
                          onClick={() => void deleteGroup(group.id)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M5 7h14M9 7V5.8c0-.9.7-1.6 1.6-1.6h2.8c.9 0 1.6.7 1.6 1.6V7m-8.8 0l.7 10.2c.1 1 1 1.8 2 1.8h6.4c1 0 1.9-.8 2-1.8L18 7M10 10.2v5.6M14 10.2v5.6"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <small>
                          {group.codes.length} codigos {group.isLocked ? '| travado' : '| destravado'}
                        </small>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="empty-state compact-empty">Nenhum grupo criado ainda.</p>
                )}
              </div>
            </div>

            {selectedGroup ? (
              <div className="glass-card detail-card compact-card">
                <div className="detail-header">
                  <div className="section-heading">
                    <h2>Detalhes do grupo</h2>
                    <p>
                      Atualizado em {formatDate(selectedGroup.updatedAt)} |{' '}
                      {selectedGroup.isLocked
                        ? 'Grupo travado para edicao (adicao de relatorios mensais liberada)'
                        : 'Grupo destravado'}
                    </p>
                  </div>
                  <div className="detail-actions">
                    <label className="month-selector">
                      Competencia (dataRealizacao)
                      <input
                        type="month"
                        value={reportMonth}
                        readOnly
                        title="Mes identificado automaticamente pela coluna dataRealizacao."
                      />
                    </label>
                    <button
                      type="button"
                      className="primary-button small-button inline-primary"
                      onClick={() => void saveMonthlyGroupReport(selectedGroup)}
                    >
                      {selectedGroup.isLocked ? 'Adicionar ao relatorio' : 'Salvar e travar'}
                    </button>
                    <button type="button" className="ghost-button small-button" onClick={() => void exportGroupData()}>
                      Exportar PDF
                    </button>
                  </div>
                </div>
                {reportFeedback ? <p className="feedback success">{reportFeedback}</p> : null}

                <div className="group-name-row">
                  <div className="field grow-field">
                    <label htmlFor="selectedGroupName">Nome do grupo</label>
                    {isEditingGroupName ? (
                      <div className="group-name-editor">
                        <input
                          id="selectedGroupName"
                          value={editingGroupName}
                          onChange={(event) => setEditingGroupName(event.target.value)}
                          disabled={selectedGroup.isLocked}
                        />
                        <div className="edit-actions">
                          <button type="button" className="ghost-button small-button" onClick={() => setIsEditingGroupName(false)}>
                            Cancelar
                          </button>
                          <button
                            type="button"
                            className="primary-button small-button inline-primary"
                            onClick={saveGroupName}
                            disabled={selectedGroup.isLocked}
                          >
                            Salvar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="group-name-display">
                        <strong>{selectedGroup.name}</strong>
                      </div>
                    )}
                  </div>
                </div>

                <div className="detail-grid single-detail-grid">
                  <article className="inner-card compact-inner-card">
                    <div className="panel-title-row">
                      <div>
                        <h3>Codigos do grupo</h3>
                        <p className="subtle-text">
                          Peso configurado em vermelho acima de{' '}
                          <input
                            className="inline-cutoff-input"
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={selectedGroup.cutoffPercentage}
                            disabled={selectedGroup.isLocked}
                            onChange={(event) =>
                              updateGroup(selectedGroup.id, (group) => ({
                                ...group,
                                cutoffPercentage: sanitizePercentage(event.target.value),
                              }))
                            }
                          />
                          %
                        </p>
                      </div>
                      <div className="inline-meta">
                        <span>{analytics?.groupTotal ?? 0} ocorrencias</span>
                        <span>Corte de {formatPercent(selectedGroup.cutoffPercentage)}%</span>
                      </div>
                    </div>

                    <div className="table-list compact-table-list">
                      {analytics?.codes.map((code) => (
                        <div
                          key={code.codigoProcedimento}
                          className={`table-row compact-row ${
                            code.actualPercentage >= selectedGroup.cutoffPercentage ? 'critical' : ''
                          }`}
                        >
                          <label className="code-check">
                            <input
                              type="checkbox"
                              checked={checkedGroupCodes.includes(code.codigoProcedimento)}
                              onChange={() => toggleCheckedGroupCode(selectedGroup.id, code.codigoProcedimento)}
                              disabled={selectedGroup.isLocked}
                            />
                          </label>
                          <div className="row-main">
                            <strong>{code.codigoProcedimento}</strong>
                            <span>{code.nomeProcedimento}</span>
                          </div>
                          <div className="row-stats compact-stats">
                            <span>{code.total}x</span>
                            <span>{formatPercent(code.actualPercentage)}%</span>
                          </div>
                          <button
                            type="button"
                            className="icon-button small-button group-delete-button"
                            aria-label={`Remover codigo ${code.codigoProcedimento}`}
                            disabled={selectedGroup.isLocked}
                            onClick={() =>
                              updateGroup(selectedGroup.id, (group) => ({
                                ...group,
                                codes: group.codes.filter((item) => item !== code.codigoProcedimento),
                              }))
                            }
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                d="M5 7h14M9 7V5.8c0-.9.7-1.6 1.6-1.6h2.8c.9 0 1.6.7 1.6 1.6V7m-8.8 0l.7 10.2c.1 1 1 1.8 2 1.8h6.4c1 0 1.9-.8 2-1.8L18 7M10 10.2v5.6M14 10.2v5.6"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.7"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>

                  </article>
                </div>

                <div className="detail-grid compact-detail-grid">
                  <article className="inner-card compact-inner-card">
                    <div className="panel-title-row">
                      <div>
                        <h3>Procedimentos por dentista</h3>
                        <p className={`nonconformity-text ${priorityDentistCount > 0 ? 'critical' : ''}`}>
                          {priorityDentistCount}{' '}
                          {priorityDentistCount === 1
                            ? 'dentista em nao conformidade'
                            : 'dentistas em nao conformidade'}
                        </p>
                      </div>
                    </div>

                    <div className="table-list compact-table-list">
                      {prioritizedDentists.length ? (
                        prioritizedDentists.map((dentist) => (
                          <button
                            key={dentist.nomeDentista}
                            type="button"
                            className={`dentist-card dentist-toggle ${
                              expandedDentists.includes(dentist.nomeDentista) ? 'expanded' : ''
                            } ${dentist.isPriority ? 'priority' : ''}`}
                            onClick={() => toggleDentistExpansion(dentist.nomeDentista)}
                          >
                            <div className="dentist-header">
                              <strong>{dentist.nomeDentista}</strong>
                              <span>{dentist.total} procedimentos</span>
                            </div>
                            {expandedDentists.includes(dentist.nomeDentista) ? (
                              <div className="dentist-details">
                                <div className="dentist-codes">
                                  {dentist.codes.map((code) => (
                                    <div
                                      key={`${dentist.nomeDentista}-${code.codigoProcedimento}`}
                                      className={`dentist-code ${
                                        checkedGroupCodes.includes(code.codigoProcedimento) ? 'highlighted' : ''
                                      }`}
                                    >
                                      <span>{code.codigoProcedimento}</span>
                                      <span>
                                        {code.total}x - {formatPercent((code.total / dentist.total) * 100)}%
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </button>
                        ))
                      ) : (
                        <p className="empty-state compact-empty">Nao houve procedimentos deste grupo no arquivo importado.</p>
                      )}
                    </div>
                  </article>

                  <article className="inner-card compact-inner-card">
                    <h3>Adicionar codigo</h3>
                    {selectedGroup.isLocked ? (
                      <p className="subtle-text">Grupo travado. Destrave para editar os codigos.</p>
                    ) : null}
                    <div className="field inline-field">
                      <input
                        value={editCodeQuery}
                        onChange={(event) => setEditCodeQuery(event.target.value)}
                        placeholder="Buscar codigo para adicionar"
                        disabled={selectedGroup.isLocked}
                      />
                    </div>
                    <div className="suggestion-panel edit-panel">
                      {editSuggestions.length ? (
                        editSuggestions.map((code) => (
                          <button
                            key={code.codigoProcedimento}
                            type="button"
                            className="suggestion-item"
                            onClick={() => addCodeToGroup(selectedGroup.id, code.codigoProcedimento)}
                            disabled={selectedGroup.isLocked}
                          >
                            <strong>{code.codigoProcedimento}</strong>
                            <span>{code.nomeProcedimento}</span>
                          </button>
                        ))
                      ) : (
                        <p className="empty-state compact-empty">
                          {editCodeQuery ? 'Nenhum codigo disponivel.' : 'Todos os codigos disponiveis ja estao no grupo.'}
                        </p>
                      )}
                    </div>
                  </article>
                </div>

                <article className="inner-card compact-inner-card standalone-card">
                  <h3>Distribuicao por codigo</h3>
                  <div className="bar-list">
                    {analytics?.codes.map((code) => (
                      <div key={code.codigoProcedimento} className="bar-item">
                        <div className="bar-labels">
                          <div>
                            <strong>{code.codigoProcedimento}</strong>
                            <span>{code.nomeProcedimento}</span>
                          </div>
                          <strong>{formatPercent(code.actualPercentage)}%</strong>
                        </div>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${Math.min(code.actualPercentage, 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              </div>
            ) : (
              <div className="glass-card empty-large compact-card">
                <h2>Selecione ou crie um grupo</h2>
                <p>Os detalhes do grupo aparecem aqui assim que houver uma selecao.</p>
              </div>
            )}
          </section>
        </section>
          </>
        )}
      </main>

      {isConfirmDeleteOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsConfirmDeleteOpen(false)}>
          <div
            className="modal-card glass-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-delete-title">Confirmar exclusao</h2>
            <p>Tem certeza que deseja excluir os dados importados e limpar a planilha carregada?</p>
            <div className="modal-actions">
              <button type="button" className="ghost-button small-button" onClick={() => setIsConfirmDeleteOpen(false)}>
                Cancelar
              </button>
              <button type="button" className="danger-button small-button" onClick={() => void clearImportedData()}>
                Sim, excluir
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
