import { expect, it, vi } from 'vitest';
import {
  createCatalogNonVideoUpdater,
  CATALOG_NONVIDEO_MARKER
} from '../supabase/functions/catalog-updater/nonvideo-writer';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../supabase/functions/_shared/product-catalog';
import {
  rebuildCatalogRows,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater';
import type { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import type { ClaimedCatalog } from '../supabase/functions/catalog-updater/worker';

/**
 * Owner's rule, 2026-11-20: people change, add, delete and wreck these sheets, and none of it
 * may break the program. The sheet is Soty's output; an update writes it again from the
 * records whatever it finds there.
 *
 * The incident behind it (DreamTeam, TR 84_v1): the video column of a 170-product catalog was
 * pasted over a 108-product one. The 62 links under the last product made every update of that
 * catalog fail before its first step, for good.
 *
 * A small model of a spreadsheet stands in for Google here: a grid of raw cells that grows,
 * shrinks and is renamed like the real one, read and written through the same four calls.
 */
const COLUMNS = PRODUCT_CATALOG_TEMPLATE.length;
const ID = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');
const VIDEO = catalogVideoColumnIndices()[0]!;
const LINKS = ['https://fixture.invalid/video?row=1', 'https://fixture.invalid/video?row=2'];

type Raw = string | number | boolean;
interface Tab {
  sheetId: number;
  title: string;
  grid: Raw[][];
}

function world(options: { desired?: number } = {}) {
  const item = {
    catalogId: 'catalog',
    productCount: 2,
    driveFileId: 'sheet',
    credentialId: 'credential',
    resourceKey: null,
    settings: {
      title: 'Before',
      description: 'Old text',
      price: 20,
      imageLink: 'https://fixture.invalid/image'
    },
    sourceLink: 'https://fixture.invalid/source',
    videoLink: 'https://fixture.invalid/PENDING'
  } as ClaimedCatalog;
  const desired = options.desired ?? item.productCount;
  // The sheet as the last update left it: two heading rows, two products, a roomy grid.
  const catalog: Tab = {
    sheetId: 7,
    title: PRODUCT_CATALOG_SHEET_NAME,
    grid: [
      ...rebuildCatalogRows({ record: item, preservedVideoCells: LINKS }).map(row =>
        row.map(cell => String(cell.v) as Raw)
      ),
      ...Array.from({ length: 20 }, () => Array.from({ length: COLUMNS }, () => '' as Raw))
    ]
  };
  const tabs: Tab[] = [catalog];
  const markers: string[] = [];
  let version = 1;
  const text = (value: Raw | undefined) => (value === undefined ? '' : String(value));
  const tab = (sheetId: number) => tabs.find(t => t.sheetId === sheetId)!;
  const drive = {
    getFile: vi.fn(async (id: string) => ({
      id,
      version: String(version),
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['root'],
      trashed: false,
      shortcutTargetId: null,
      capabilities: { canModifyContent: true }
    })),
    getNativeSpreadsheetSheets: vi.fn(async () =>
      tabs.map(t => ({
        sheetId: t.sheetId,
        title: t.title,
        rowCount: t.grid.length,
        columnCount: t.grid[0]!.length
      }))
    ),
    readNativeCatalogColumns: vi.fn(
      async (input: {
        sheetName: string;
        columns: number[];
        expectedRows: number;
        tolerant?: boolean;
      }) => {
        // The strict reader refuses a sheet that holds anything it did not expect — which is
        // the failure this suite is about. Every read of the update must be the tolerant one.
        expect(input.tolerant).toBe(true);
        const read = tabs.find(t => t.title === input.sheetName);
        if (!read) throw new Error('DRIVE_UNAVAILABLE');
        return input.columns.map(c => {
          if (c >= read.grid[0]!.length) throw new Error('range exceeds grid limits');
          return Array.from({ length: input.expectedRows }, (_, r) => text(read.grid[r]?.[c]));
        });
      }
    ),
    renameNativeSpreadsheetSheet: vi.fn(async (input: { sheetId: number; title: string }) => {
      tab(input.sheetId).title = input.title;
      version += 1;
    }),
    writeNativeSpreadsheetCells: vi.fn(
      async (input: {
        updates: { sheetId: number; rowIndex: number; columnIndex: number; values: string[] }[];
        frame?: { sheetId: number; rows: number; columns: number };
        marker: { key: string; value: string };
      }) => {
        expect(input.marker.key).toBe(CATALOG_NONVIDEO_MARKER);
        if (input.frame) {
          const { grid } = tab(input.frame.sheetId);
          const width = Math.max(grid[0]!.length, input.frame.columns);
          while (grid.length < input.frame.rows) grid.push([]);
          for (const row of grid) while (row.length < width) row.push('');
          grid.forEach((row, r) =>
            row.forEach((_, c) => {
              if (r >= input.frame!.rows) row[c] = '';
            })
          );
        }
        for (const u of input.updates)
          u.values.forEach((value, i) => {
            const row = tab(u.sheetId).grid[u.rowIndex + i];
            // Google fails the whole batch on a cell outside the grid.
            if (!row || u.columnIndex >= row.length) throw new Error('outside the grid');
            row[u.columnIndex] = value;
          });
        markers.push(input.marker.value);
        version += 1;
      }
    ),
    readNativeSpreadsheetMarkers: vi.fn(async () => markers)
  };
  const rpc = vi.fn(async () => ({
    data: {
      attemptId: 'attempt',
      currentProductCount: item.productCount,
      productCount: desired,
      fileId: 'sheet',
      credentialId: 'credential',
      rootFolderId: 'root',
      contextToken: 'a'.repeat(64)
    },
    error: null
  }));
  const prepare = createCatalogNonVideoUpdater(
    { rpc },
    'worker',
    async () => drive as unknown as GoogleDriveClient
  );
  /** One whole regular update, as the worker runs it; returns the rows it meant to deliver. */
  async function update() {
    const prepared = await prepare(item);
    const rows = rebuildCatalogRows({
      record: {
        ...item,
        productCount: desired,
        settings: { ...item.settings, title: 'After', description: 'New text' }
      },
      preservedVideoCells: prepared.videoCells
    });
    await prepared.write(rows, 'marker');
    await prepared.verify('marker');
    return { prepared, rows: rows.map(row => row.map(cell => String(cell.v))) };
  }
  return { item, catalog, tabs, drive, update, markers };
}

/** Every row that holds a value, as text, in the template's columns: the products and no more. */
const filled = (grid: Raw[][]) =>
  grid
    .map(row => row.map(value => String(value)))
    .filter(row => row.some(value => value !== ''))
    .map(row => row.slice(0, COLUMNS));

it('updates a sheet with another catalog’s video column pasted over it (TR 84_v1)', async () => {
  const w = world();
  // 170 links over a 2-product sheet: the products' own cells replaced, and 168 more below.
  for (let r = 2; r < 172; r += 1) {
    w.catalog.grid[r] ??= Array.from({ length: COLUMNS }, () => '' as Raw);
    w.catalog.grid[r]![VIDEO] = 'https://fixture.invalid/other-catalog.mp4';
  }
  const { rows, prepared } = await w.update();
  // The publication lane owns the products' video cells: they are kept as found, and that
  // lane writes its own links over them the next time it publishes.
  expect(prepared.videoCells).toEqual([
    'https://fixture.invalid/other-catalog.mp4',
    'https://fixture.invalid/other-catalog.mp4'
  ]);
  expect(filled(w.catalog.grid)).toEqual(rows);
  expect(w.catalog.grid).toHaveLength(172); // emptied, not removed
});

it('writes the headings, ids and products again over whatever was typed into them', async () => {
  const w = world();
  w.catalog.grid[0]![ID] = 'мої товари';
  w.catalog.grid[1]![ID] = 'ID';
  w.catalog.grid[0]![VIDEO] = '';
  w.catalog.grid[1]![VIDEO] = 'відео';
  w.catalog.grid[2]![ID] = 84; // a number, as a typed one comes back
  w.catalog.grid[3]![ID] = w.catalog.grid[2]![ID]!; // a duplicate
  w.catalog.grid[2]![1] = '=HYPERLINK("x")';
  w.catalog.grid[3] = Array.from({ length: COLUMNS }, () => '' as Raw); // a product wiped out
  w.catalog.grid[3]![VIDEO] = LINKS[1]!;
  const { rows } = await w.update();
  expect(filled(w.catalog.grid)).toEqual(rows);
  expect(w.catalog.grid[1]![ID]).toBe('id');
  expect(w.catalog.grid[1]![VIDEO]).toBe(PRODUCT_CATALOG_TEMPLATE[VIDEO]!.key);
  expect(w.catalog.grid.slice(2, 4).map(row => row[VIDEO])).toEqual(LINKS);
  expect(new Set(w.catalog.grid.slice(2, 4).map(row => row[ID])).size).toBe(2);
});

it('grows a sheet whose rows or last columns were deleted', async () => {
  const rowsGone = world();
  rowsGone.catalog.grid.length = 3; // the headings and one product are all that is left
  const shortened = await rowsGone.update();
  // The product that was deleted with its row comes back; its video link went with the row.
  expect(shortened.prepared.videoCells).toEqual([LINKS[0], '']);
  expect(rowsGone.catalog.grid).toHaveLength(4);
  expect(filled(rowsGone.catalog.grid)).toEqual(shortened.rows);

  const columnsGone = world();
  for (const row of columnsGone.catalog.grid) row.length = VIDEO; // the video column and on
  const { rows, prepared } = await columnsGone.update();
  // Deleted links are gone; there is nothing to keep, and the lane that owns them says so.
  expect(prepared.videoCells).toEqual(['', '']);
  expect(columnsGone.catalog.grid[0]).toHaveLength(COLUMNS);
  expect(filled(columnsGone.catalog.grid)).toEqual(rows);
});

it('empties rows added under the products, and keeps a column someone added beside them', async () => {
  const w = world();
  w.catalog.grid.forEach((row, r) => row.push(r === 1 ? 'custom_label_0' : r < 4 ? 'мітка' : ''));
  w.catalog.grid[10]![3] = 'забута примітка';
  w.catalog.grid[21]![0] = 'ще один товар';
  w.catalog.grid[21]![COLUMNS] = 'і його мітка';
  const { rows } = await w.update();
  expect(filled(w.catalog.grid)).toEqual(rows);
  // Their column, in the product rows, as they left it; under the products, nothing.
  expect(w.catalog.grid.map(row => row[COLUMNS])).toEqual([
    'мітка',
    'custom_label_0',
    'мітка',
    'мітка',
    ...Array.from({ length: 20 }, () => '')
  ]);
});

it('makes room for added products in a sheet that has someone’s rows where they go', async () => {
  const w = world({ desired: 3 });
  w.catalog.grid[4] = Array.from({ length: COLUMNS }, () => 'чужий рядок' as Raw);
  const { rows, prepared } = await w.update();
  expect(rows).toHaveLength(5);
  // The new product's video cell is the publication lane's to fill: empty until it does.
  expect(prepared.videoCells).toEqual([...LINKS, '']);
  expect(filled(w.catalog.grid)).toEqual(rows);
});

it('gives a renamed tab its name back and updates it', async () => {
  const w = world();
  w.catalog.title = 'Аркуш1';
  const { rows } = await w.update();
  expect(w.drive.renameNativeSpreadsheetSheet).toHaveBeenCalledExactlyOnceWith({
    fileId: 'sheet',
    sheetId: 7,
    title: PRODUCT_CATALOG_SHEET_NAME
  });
  expect(w.catalog.title).toBe(PRODUCT_CATALOG_SHEET_NAME);
  expect(filled(w.catalog.grid)).toEqual(rows);
});

it('leaves someone’s extra tab alone and updates the catalog beside it', async () => {
  const w = world();
  w.tabs.unshift({ sheetId: 99, title: 'Нотатки', grid: [['моє', 'не чіпати']] });
  const { rows } = await w.update();
  expect(filled(w.catalog.grid)).toEqual(rows);
  expect(w.tabs[0]!.grid).toEqual([['моє', 'не чіпати']]);
  expect(w.drive.renameNativeSpreadsheetSheet).not.toHaveBeenCalled();
});

it('says the file changed, and writes nothing, when no tab can be told to be the catalog', async () => {
  const w = world();
  w.catalog.title = 'Аркуш1';
  w.tabs.push({ sheetId: 99, title: 'Аркуш2', grid: [['?']] });
  await expect(w.update()).rejects.toThrow('SOURCE_CHANGED');
  expect(w.drive.renameNativeSpreadsheetSheet).not.toHaveBeenCalled();
  expect(w.drive.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});

it('an untouched sheet is updated exactly as before, with nothing extra in the way', async () => {
  const w = world();
  const { rows, prepared } = await w.update();
  expect(prepared.videoCells).toEqual(LINKS);
  expect(filled(w.catalog.grid)).toEqual(rows);
  expect(w.markers).toEqual(['marker']);
  expect(w.drive.renameNativeSpreadsheetSheet).not.toHaveBeenCalled();
});

it('sends the independent reads of an update together and reads the folders above once', async () => {
  // The owner, 2026-11-25: updating only the texts of a catalog takes long. Every catalog
  // asked Google a dozen questions one after another; the ones that do not depend on each
  // other now go out together.
  const w = world();
  const getFile = w.drive.getFile.getMockImplementation()!;
  w.drive.getFile.mockImplementation(async (id: string) => ({
    ...(await getFile(id)),
    parents: id === 'sheet' ? ['folder'] : ['root']
  }));
  let sheetsAsked!: () => void;
  const asked = new Promise<void>(resolve => (sheetsAsked = resolve));
  const sheets = w.drive.getNativeSpreadsheetSheets.getMockImplementation()!;
  w.drive.getNativeSpreadsheetSheets.mockImplementation(async () => {
    sheetsAsked();
    return sheets();
  });
  const markers = w.drive.readNativeSpreadsheetMarkers.getMockImplementation()!;
  let first = true;
  w.drive.readNativeSpreadsheetMarkers.mockImplementation(async () => {
    // Before the write the marker lookup answers only once the tabs were asked for too:
    // one after the other, as before, this update would never finish.
    if (first) {
      first = false;
      await asked;
    }
    return markers();
  });
  const { rows } = await w.update();
  expect(filled(w.catalog.grid)).toEqual(rows);
  // The folder is read once for the whole update; the sheet itself every time it is asked.
  const reads = w.drive.getFile.mock.calls.map(([id]) => id);
  expect(reads.filter(id => id === 'folder')).toHaveLength(1);
  expect(reads.filter(id => id === 'sheet').length).toBeGreaterThanOrEqual(4);
});

it('names a marker another writer left before anything the reads beside it found', async () => {
  const w = world();
  w.markers.push('someone-else');
  w.drive.getNativeSpreadsheetSheets.mockRejectedValue(new Error('DRIVE_UNAVAILABLE'));
  await expect(w.update()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(w.drive.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});

it('still refuses a write whose proof finds the publication lane’s cells changed', async () => {
  const w = world();
  const write = w.drive.writeNativeSpreadsheetCells.getMockImplementation()!;
  w.drive.writeNativeSpreadsheetCells.mockImplementation(async input => {
    await write(input);
    w.catalog.grid[2]![VIDEO] = 'https://fixture.invalid/someone-else.mp4';
  });
  await expect(w.update()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
