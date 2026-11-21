// Excel workbooks become datasets: each sheet's measurement columns, named by
// the label above them, with summary blocks left out.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addMaterials, analyze, type Row } from '../../src/engine/materials.js'
import { readWorkbook, sheetTable } from '../../src/engine/workbook.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A one-sheet workbook: a "Delay ms" column of 40 values beside a short summary block. */
function workbook(at: string): string {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="New SW" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Delay ms</t></si><si><t>Min</t></si><si><r><t>Ma</t></r><r><t>x</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>137</v></c></row><row r="2"><c r="B2" t="s"><v>2</v></c><c r="C2"><f>MAX(A3:A42)</f><v>429</v></c></row>${
      Array.from({ length: 40 }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}"><v>${i === 0 ? 137 : i === 39 ? 429 : 200 + i}</v></c></row>`).join('')}</sheetData></worksheet>`,
  }
  const root = join(at, 'xlsx')
  for (const [name, text] of Object.entries(parts)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  execFileSync('zip', ['-qr', '../book.xlsx', '.'], { cwd: root })
  return join(at, 'book.xlsx')
}

describe('workbooks', () => {
  it('reads a sheet and keeps its measurement column, not its summary block', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const [sheet] = readWorkbook(workbook(dir))
    expect(sheet.name).toBe('New SW')
    expect(sheet.rows[1][1]).toBe('Max')
    const table = sheetTable(sheet)!
    expect(table.columns).toEqual(['Delay ms'])
    expect(table.rows).toHaveLength(40)
  })

  it('takes a workbook in as one private dataset per data sheet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const [m] = await addMaterials(join(dir, 'p'), [{ source: workbook(dir) }])
    expect(m).toMatchObject({ id: 'M1', kind: 'dataset', name: 'book.xlsx › New SW', private: true })
    expect(readFileSync(join(dir, 'p', m.file!), 'utf8').split('\n')[0]).toBe('Delay ms')
  })
})

describe('latency analyses', () => {
  const rows: Row[] = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((x) => ({ delay: String(x) }))
  it('gives a percentile and the share of values under a threshold', () => {
    expect(analyze(rows, { id: 'A1', dataset: 'M1', op: 'quantile', column: 'delay', column2: null, by: null, value: '0.95', where: null }).value).toBe('955')
    expect(analyze(rows, { id: 'A2', dataset: 'M1', op: 'share', column: 'delay', column2: null, by: null, value: '<700', where: null }).value).toBe('60%')
  })
})

describe('large datasets', () => {
  it('profiles and measures a column of 400,000 values without overflowing the stack', async () => {
    const { profileDataset } = await import('../../src/engine/materials.js')
    const rows: Row[] = Array.from({ length: 400_000 }, (_, i) => ({ delay: String(18 + (i % 480)) }))
    const profile = profileDataset(rows)
    expect(JSON.stringify(profile)).toContain('"min":18')
    expect(analyze(rows, { id: 'A1', dataset: 'M1', op: 'max', column: 'delay', column2: null, by: null, value: null, where: null }).value).toBe('497')
  })
})
