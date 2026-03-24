# Control Glosa

Aplicacao web em React + TypeScript para importar arquivos `CSV` ou `XLSX`, analisar os campos `codigoProcedimento`, `nomeProcedimento` e `nomeDentista`, e gerenciar grupos de codigos com CRUD completo.

## Funcionalidades

- Importacao de planilhas com validacao das colunas obrigatorias
- Verificacao de conflitos entre `codigoProcedimento` e `nomeProcedimento`
- Criacao, edicao e exclusao de grupos de codigos
- Calculo da repeticao de cada codigo e seu percentual real dentro do grupo
- Peso configuravel por codigo com destaque em vermelho acima de `50%`
- Analise por dentista com quantidade de procedimentos por codigo
- Persistencia local em `localStorage`

## Executar

```bash
npm install
npm run dev
```

## Build de producao

```bash
npm run build
```
