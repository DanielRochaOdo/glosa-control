# Control Glosa

Aplicacao web em React + TypeScript para importar arquivos `CSV` ou `XLSX`, analisar os campos `codigoProcedimento`, `nomeProcedimento`, `nomeDentista` e `dataRealizacao`, e gerenciar grupos de codigos com CRUD completo.

## Funcionalidades

- Importacao de planilhas com validacao das colunas obrigatorias
- Competencia mensal detectada automaticamente pela coluna `dataRealizacao`
- Verificacao de conflitos entre `codigoProcedimento` e `nomeProcedimento`
- Criacao, edicao e exclusao de grupos de codigos
- Travamento de grupos (cadeado aberto/fechado) com persistencia dos codigos marcados
- Calculo da repeticao de cada codigo e seu percentual real dentro do grupo
- Peso configuravel por codigo com destaque em vermelho acima de `50%`
- Analise por dentista com quantidade de procedimentos por codigo
- Tela de graficos de barra para comparativo mensal por grupo
- Persistencia local e em Supabase (grupos + historico mensal)

## Executar

```bash
npm install
npm run dev
```

## Configuracao Supabase

1. Copie `.env.example` para `.env` na raiz do projeto.
2. Preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
3. Aplique as migracoes SQL:

```bash
supabase db push
```

## Build de producao

```bash
npm run build
```
