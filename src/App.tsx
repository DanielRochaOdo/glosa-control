import { ChangeEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeGroup, summarizeCodes } from './lib/analytics';
import { parseUploadedFile } from './lib/parser';
import { loadDataset, loadGroups, saveDataset, saveGroups } from './lib/storage';
import type { CodeSummary, DentistBreakdown, ImportedDataset, ProcedureGroup } from './types';

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

type PrioritizedDentist = DentistBreakdown & {
  selectedTotal: number;
  selectedPercentage: number;
  isPriority: boolean;
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
  const [groupName, setGroupName] = useState('');
  const [createCodeQuery, setCreateCodeQuery] = useState('');
  const [editCodeQuery, setEditCodeQuery] = useState('');
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isRestoringDataset, setIsRestoringDataset] = useState(true);
  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [checkedGroupCodes, setCheckedGroupCodes] = useState<string[]>([]);
  const [expandedDentists, setExpandedDentists] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
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
    try {
      saveGroups(groups);
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : 'Falha ao salvar os grupos localmente.');
    }
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
    if (!selectedGroupId && groups.length > 0) {
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

  useEffect(() => {
    setIsEditingGroupName(false);
    setEditingGroupName(selectedGroup?.name ?? '');
    setExpandedDentists([]);
    setCheckedGroupCodes([]);
  }, [selectedGroup?.id, selectedGroup?.name]);

  useEffect(() => {
    if (!selectedGroup) {
      setCheckedGroupCodes([]);
      return;
    }

    setCheckedGroupCodes((current) => current.filter((code) => selectedGroup.codes.includes(code)));
  }, [selectedGroup]);

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

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setIsImporting(true);
    setFeedback(null);
    setErrorMessage(null);
    setStorageMessage(null);

    try {
      const parsed = await parseUploadedFile(file);
      setDataset(parsed);
      setFeedback(`${parsed.records.length} registros importados de ${parsed.fileName}.`);
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

  const toggleCheckedGroupCode = (code: string) => {
    setCheckedGroupCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
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
      cutoffPercentage: 50,
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
          ? {
              ...updater(group),
              updatedAt: new Date().toISOString(),
            }
          : group,
      ),
    );
  };

  const addCodeToGroup = (groupId: string, code: string) => {
    updateGroup(groupId, (group) => ({
      ...group,
      codes: [...group.codes, code],
    }));
    setEditCodeQuery('');
  };

  const deleteGroup = (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    const nextGroups = groups.filter((item) => item.id !== groupId);
    setGroups(nextGroups);
    setSelectedGroupId(nextGroups[0]?.id ?? null);
    setFeedback(group ? `Grupo "${group.name}" removido.` : 'Grupo removido.');
  };

  const toggleDentistExpansion = (dentistName: string) => {
    setExpandedDentists((current) =>
      current.includes(dentistName)
        ? current.filter((item) => item !== dentistName)
        : [...current, dentistName],
    );
  };

  const clearImportedData = () => {
    setDataset(null);
    setGroups([]);
    setSelectedGroupId(null);
    setSelectedCodes([]);
    setGroupName('');
    setCreateCodeQuery('');
    setEditCodeQuery('');
    setIsEditingGroupName(false);
    setEditingGroupName('');
    setFeedback('Dados importados removidos com sucesso.');
    setErrorMessage(null);
    setStorageMessage(null);
    setIsConfirmDeleteOpen(false);
  };

  const saveGroupName = () => {
    if (!selectedGroup) {
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
    setSelectedGroupId(group.id);
    setEditingGroupName(group.name);
    setIsEditingGroupName(true);
  };

  const exportGroupData = async () => {
    if (!selectedGroup || !analytics) {
      setErrorMessage('Selecione um grupo com dados para exportar.');
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
      head: [['Dentista', 'Codigo', 'Procedimento', 'Total', '% selecionado', 'Prioridade']],
      body: prioritizeDentists(analytics.dentists, checkedGroupCodes, selectedGroup.cutoffPercentage).flatMap((dentist) =>
        dentist.codes.map((code) => [
          dentist.nomeDentista,
          code.codigoProcedimento,
          code.nomeProcedimento,
          String(code.total),
          `${formatPercent(dentist.selectedPercentage)}%`,
          dentist.isPriority ? 'Sim' : 'Nao',
        ]),
      ),
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
        4: { cellWidth: 60, halign: 'right' },
        5: { cellWidth: 55, halign: 'center' },
      },
      didParseCell: (hookData) => {
        if (hookData.section !== 'body') {
          return;
        }

        const rowValues = hookData.row.raw as string[];

        if (rowValues[5] === 'Sim') {
          hookData.cell.styles.textColor = [154, 60, 71];
          hookData.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawPage: (data) => {
        const pageNumber = doc.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(110, 124, 114);
        doc.text(`Pagina ${pageNumber}`, data.settings.margin.left, doc.internal.pageSize.getHeight() - 14);
      },
    });

    doc.save(`${safeGroupName.replace(/[^\w-]+/g, '_')}.pdf`);
    setFeedback(`Exportacao em PDF do grupo "${safeGroupName}" concluida.`);
    setErrorMessage(null);
  };

  return (
    <div className="app-shell">
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-top-row">
            <span className="eyebrow">Controle de Glosa</span>
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
                className="danger-button small-button"
                onClick={() => setIsConfirmDeleteOpen(true)}
                disabled={!dataset && groups.length === 0}
              >
                Excluir
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
                        onClick={() => setSelectedGroupId(group.id)}
                      >
                        <span>{group.name}</span>
                      </button>
                      <div className="group-item-meta">
                        <button
                          type="button"
                          className="icon-button small-button group-edit-button"
                          aria-label={`Editar grupo ${group.name}`}
                          onClick={() => startEditingGroup(group)}
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
                          className="icon-button small-button group-delete-button"
                          aria-label={`Excluir grupo ${group.name}`}
                          onClick={() => deleteGroup(group.id)}
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
                        <small>{group.codes.length} codigos</small>
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
                    <p>Atualizado em {formatDate(selectedGroup.updatedAt)}</p>
                  </div>
                  <div className="detail-actions">
                    <button type="button" className="ghost-button small-button" onClick={exportGroupData}>
                      Exportar PDF
                    </button>
                  </div>
                </div>

                <div className="group-name-row">
                  <div className="field grow-field">
                    <label htmlFor="selectedGroupName">Nome do grupo</label>
                    {isEditingGroupName ? (
                      <div className="group-name-editor">
                        <input
                          id="selectedGroupName"
                          value={editingGroupName}
                          onChange={(event) => setEditingGroupName(event.target.value)}
                        />
                        <div className="edit-actions">
                          <button type="button" className="ghost-button small-button" onClick={() => setIsEditingGroupName(false)}>
                            Cancelar
                          </button>
                          <button type="button" className="primary-button small-button inline-primary" onClick={saveGroupName}>
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
                              onChange={() => toggleCheckedGroupCode(code.codigoProcedimento)}
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
                        <p className="subtle-text">Visualizacao abaixo dos codigos, no mesmo fluxo do PDF</p>
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
                    <div className="field inline-field">
                      <input
                        value={editCodeQuery}
                        onChange={(event) => setEditCodeQuery(event.target.value)}
                        placeholder="Buscar codigo para adicionar"
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
              <button type="button" className="danger-button small-button" onClick={clearImportedData}>
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
