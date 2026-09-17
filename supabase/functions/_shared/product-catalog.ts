/**
 * A video's product catalog sheet (feature 022) — everything about it that is not I/O.
 *
 * The owner's Meta catalog template, the four limits a person can hit, and the rows a sheet is
 * made of. Its only import is the per-row details beside it: this file is read by the Edge
 * Function and by vitest, and the web keeps its own copy of the limits (`apps/web/src/team/product-catalog/limits.ts`) because
 * the one shared package cannot change without a desktop release. A parity test holds the two
 * together.
 *
 * The template itself is the contract in `specs/022-video-catalog-sheet/contracts/`; a test
 * keeps `PRODUCT_CATALOG_TEMPLATE` equal to its JSON form, header strings byte for byte.
 */

import {
  colorOf,
  contentId,
  drawProductDetails,
  inventedBrand,
  pictureFacts,
  recolour
} from './product-details.ts';

export const PRODUCT_COUNT_MIN = 1;
export const PRODUCT_COUNT_MAX = 400;
export const PRODUCT_COUNT_DEFAULT = 100;
export const PRICE_MIN = 1;
export const PRICE_MAX = 999_999;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 9999;
export const IMAGE_LINK_MAX = 2048;
export const SOURCE_LINK_MAX = 8192;

export const PRODUCT_CATALOG_SHEET_NAME = 'catalog_products';
export const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
/** The description row and the key row come before the first product. */
export const PRODUCT_CATALOG_HEADER_ROWS = 2;

export type Cell = { t: 'string'; v: string } | { t: 'number'; v: number };

export interface ProductCatalogSettingsValues {
  title: string;
  description: string;
  price: number;
  imageLink: string;
}

/**
 * The rest of what one product says (024, US21).
 *
 * Every row used to carry Meta's own example — royal blue, size M, cotton, "stripes", one barcode,
 * a sale that ended in 2020 — under a hundred different names, which reads as one product typed a
 * hundred times. These follow the name where the name decides them (a Navy Twill Jeans row is navy
 * and twill) and are drawn where nothing decides them.
 */
export interface ProductCatalogRowDetails {
  /** The discounted price, under the row's own price. */
  salePrice: number;
  /** When the sale runs, as Meta's `start/end`. */
  saleWindow: string;
  color: string;
  size: string;
  material: string;
  pattern: string;
  gender: string;
  style: string;
  googleCategory: string;
  fbCategory: string;
  /** The made-up label the whole catalog sells under. */
  brand: string;
  quantity: number;
  shippingWeight: string;
  shipping: string;
  videoTag: string;
  /** What distinguishes this row's video link, in place of 022's row number. */
  videoParam: string;
  tags: readonly [string, string];
  /**
   * The file name of the picture this row shows (024, US27). Never written to the sheet: it is
   * kept so a later update can pair the row's words with the picture it already has.
   */
  pictureName: string | null;
}

/**
 * What one product row says (024): its own name, text, price and picture. A catalog made from the
 * space's pools gives every row different ones; a catalog from before pools repeats the settings.
 * The US21 details come with a catalog planned from pools; a sheet from before them keeps Meta's
 * example values, which is what `PRODUCT_CATALOG_TEMPLATE` falls back to.
 */
export interface ProductCatalogRowValues extends Partial<ProductCatalogRowDetails> {
  title: string;
  description: string;
  price: number;
  imageLink: string;
}

/** A space's settings as stored now: single values are fallbacks, price is a range. */
export interface ProductCatalogSpaceSettings {
  title: string | null;
  description: string | null;
  imageLink: string | null;
  priceMin: number;
  priceMax: number;
}

/**
 * A picture file as Meta can fetch it. The viewer page (`/file/d/…/view`) is HTML, not an image;
 * `uc?export=view` answers with the file itself once it is shared by link.
 */
export function driveImageLink(fileId: string, resourceKey: string | null): string {
  const base = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
  return resourceKey ? `${base}&resourcekey=${encodeURIComponent(resourceKey)}` : base;
}

/** A whole number of dollars in the range, both ends included. */
export function randomPrice(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * Every row's values, from the draws and the settings (024, US21).
 *
 * A drawn text and a drawn picture go to a row each, in order; a pool that was empty leaves the
 * settings' single value in its place. Null when some row would have no name, text or picture at
 * all — the space is not ready to make a catalog.
 *
 * The rest of the row is made up around its name (024, US21): the colour and the fabric the name
 * already says, a category and a style that suit the garment, and a size, a pattern, a weight and
 * a stock count drawn per row. One invented brand covers the whole catalog, the way a shop has
 * one name.
 */
export function planCatalogRows(input: {
  count: number;
  settings: ProductCatalogSpaceSettings;
  texts: ReadonlyArray<{ title: string; description: string }>;
  /** The pictures drawn for this catalog, with the file names that say what they show. */
  images: ReadonlyArray<{ link: string; name?: string | null }>;
  random?: () => number;
  now?: number;
  /** The catalog's own label; invented when none is given. */
  brand?: string;
}): ProductCatalogRowValues[] | null {
  const random = input.random ?? Math.random;
  const brand = input.brand ?? inventedBrand(random);
  const rows: ProductCatalogRowValues[] = [];
  const spare = [...input.texts];
  for (let index = 0; index < input.count; index += 1) {
    const image =
      input.images.length > 0
        ? input.images[index % input.images.length]
        : { link: input.settings.imageLink ?? '', name: null };
    const facts = image?.name ? pictureFacts(image.name) : { garment: null, color: null };
    const text = takeMatchingText(spare, facts);
    const imageLink = image?.link || input.settings.imageLink;
    /* The picture decides the colour: a name in navy over a photo of a black hoodie is the one
       contradiction a reader sees without opening anything (024, US27). */
    const said = text ? colorOf(text.title) : null;
    const recoloured =
      text && facts.color && said && said !== facts.color
        ? {
            title: recolour(text.title, said, facts.color),
            description: recolour(text.description, said, facts.color)
          }
        : text;
    const title = recoloured?.title ?? input.settings.title;
    const description = recoloured?.description ?? input.settings.description;
    if (!title || !description || !imageLink) return null;
    const price = randomPrice(input.settings.priceMin, input.settings.priceMax, random);
    rows.push({
      title,
      description,
      imageLink,
      price,
      ...drawProductDetails({
        title,
        price,
        brand,
        random,
        now: input.now,
        pictureColor: facts.color
      }),
      pictureName: image?.name ?? null
    });
  }
  return rows;
}

/**
 * The name that suits this picture, taken out of what was drawn (024, US27).
 *
 * The pools are drawn without repeats and paired here rather than by position: a photo named
 * `hoodie_black_01.jpg` takes a hoodie name, and a black one where the pool has it. When nothing
 * matches — the picture's name says nothing, or the pool holds no such garment — the next name
 * is used, which is exactly what happened to every row before.
 */
export function takeMatchingText(
  spare: Array<{ title: string; description: string }>,
  facts: { garment: { name: string } | null; color: string | null }
): { title: string; description: string } | null {
  if (spare.length === 0) return null;
  const wanted = facts.garment?.name ?? null;
  if (!wanted) return spare.shift() ?? null;
  /* The name is read with the same vocabulary as the file name, so "Nova Cotton Oversized Tee"
     and `tshirt_white_01.jpg` are known to be the same garment. */
  const reads = spare.map(text => pictureFacts(text.title));
  const exact = reads.findIndex(
    read => read.garment?.name === wanted && facts.color !== null && read.color === facts.color
  );
  const sameGarment = reads.findIndex(read => read.garment?.name === wanted);
  const index = exact >= 0 ? exact : sameGarment >= 0 ? sameGarment : 0;
  return spare.splice(index, 1)[0] ?? null;
}

type ColumnSource =
  | { kind: 'contentId' }
  | { kind: 'setting'; setting: 'title' | 'description' | 'price' | 'imageLink' }
  | { kind: 'sourceLink' }
  | { kind: 'copyOf'; column: string }
  | { kind: 'videoLink' }
  | { kind: 'rowDetail'; detail: RowDetailSource; fallback: Cell }
  | { kind: 'blank' }
  | { kind: 'fixed'; cell: Cell };

/** A column filled from the row's own details, with `tag0`/`tag1` for the two product tags. */
type RowDetailSource = keyof ProductCatalogRowDetails | 'tag0' | 'tag1';

export interface ProductCatalogColumn {
  column: string;
  key: string;
  description: string;
  source: ColumnSource;
}

export type ParseResult<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A product count as a person types it: digits only, surrounding spaces and leading zeros
 * forgiven (`007` is seven), and never more than three digits — the dialog's field is that wide.
 */
export function parseProductCount(value: unknown): ParseResult<number, 'count'> {
  let digits: string;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return { ok: false, error: 'count' };
    digits = String(value);
  } else if (typeof value === 'string') {
    digits = value.trim();
  } else {
    return { ok: false, error: 'count' };
  }
  if (!/^\d{1,3}$/u.test(digits)) return { ok: false, error: 'count' };
  const count = Number(digits);
  return count >= PRODUCT_COUNT_MIN && count <= PRODUCT_COUNT_MAX
    ? { ok: true, value: count }
    : { ok: false, error: 'count' };
}

/** An `http`/`https` link with nothing around or inside it that a browser would not keep. */
/**
 * A link as pasted (024: the owner wants no validation): whitespace dropped, `https://` put in
 * front of a link typed without its scheme. Only empty or overlong is refused. The web copy in
 * `apps/web/src/team/product-catalog/limits.ts` must agree (parity test).
 */
export function parseWebLink(value: unknown, max: number): ParseResult<string, 'link'> {
  if (typeof value !== 'string') return { ok: false, error: 'link' };
  const compact = value.replace(/\s+/gu, '');
  if (compact.length === 0) return { ok: false, error: 'link' };
  const link = /^https?:\/\//iu.test(compact) ? compact : `https://${compact}`;
  return link.length > max ? { ok: false, error: 'link' } : { ok: true, value: link };
}

/** A whole-dollar price as the sheet writes it — the owner's form, comma and all. */
export function formatPrice(price: number): string {
  return `${price},00 USD`;
}

/**
 * The link a signed-out viewer can open a Drive video with. Drive hands back `usp=drivesdk`;
 * the owner's template uses `usp=sharing`, and a file with a resource key needs it in the link.
 */
export function videoShareLink(fileId: string, resourceKey: string | null): string {
  const base = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view?usp=sharing`;
  return resourceKey ? `${base}&resourcekey=${encodeURIComponent(resourceKey)}` : base;
}

/**
 * `IN 40.mp4`, variation 2 → `IN 40_v2_catalog`: the one naming rule for a catalog sheet (024,
 * US15). The owner names the catalog on Meta the same way, so the sheet, the product and the ad
 * account all say which video and which variation it is.
 */
export function productCatalogName(videoName: string, variant: number): string {
  const stem = videoName.replace(/\.[^.]+$/u, '');
  return `${stem.length > 0 ? stem : videoName}_v${variant}_catalog`;
}

export const PRODUCT_CATALOG_TEMPLATE: readonly ProductCatalogColumn[] = [
  {
    column: 'A',
    key: 'id',
    description:
      "# Обязательно | A unique content ID for the item. Use the item's SKU if you can. Each content ID must appear only once in your catalog. To run dynamic ads this ID must exactly match the content ID for the same item in your Meta Pixel code. Character limit: 100",
    source: { kind: 'contentId' }
  },
  {
    column: 'B',
    key: 'title',
    description:
      '# Обязательно | A specific and relevant title for the item. See title specifications: https://www.facebook.com/business/help/2104231189874655 Character limit: 200',
    source: { kind: 'setting', setting: 'title' }
  },
  {
    column: 'C',
    key: 'description',
    description:
      "# Обязательно | A short and relevant description of the item. Include specific or unique product features like material or color. Use plain text and don't enter text in all capital letters. See description specifications: https://www.facebook.com/business/help/2302017289821154 Character limit: 9999",
    source: { kind: 'setting', setting: 'description' }
  },
  {
    column: 'D',
    key: 'availability',
    description:
      '# Обязательно | The current availability of the item. | Поддерживаемые значения: in stock; out of stock',
    source: { kind: 'fixed', cell: { t: 'string', v: 'in stock' } }
  },
  {
    column: 'E',
    key: 'condition',
    description:
      '# Обязательно | The current condition of the item. | Поддерживаемые значения: new; used',
    source: { kind: 'fixed', cell: { t: 'string', v: 'new' } }
  },
  {
    column: 'F',
    key: 'price',
    description:
      "# Обязательно | The price of the item. Format the price as a number followed by the 3-letter currency code (ISO 4217 standards). Use a period (.) as the decimal point; don't use a comma.",
    source: { kind: 'setting', setting: 'price' }
  },
  {
    column: 'G',
    key: 'link',
    description:
      '# Обязательно | The URL of the specific product page where people can buy the item.',
    source: { kind: 'sourceLink' }
  },
  {
    column: 'H',
    key: 'image_link',
    description:
      '# Обязательно | The URL for the main image of your item. Images must be in a supported format (JPG/GIF/PNG) and at least 500 x 500 pixels.',
    source: { kind: 'setting', setting: 'imageLink' }
  },
  {
    column: 'I',
    key: 'brand',
    description: '# Обязательно | Фирменное название товара. Не более 100 символов.',
    source: { kind: 'rowDetail', detail: 'brand', fallback: { t: 'string', v: 'Facebook' } }
  },
  {
    column: 'J',
    key: 'google_product_category',
    description:
      '# Необязательно | The Google product category for the item. Learn more about product categories: https://www.facebook.com/business/help/526764014610932.',
    source: {
      kind: 'rowDetail',
      detail: 'googleCategory',
      fallback: { t: 'string', v: 'Apparel & Accessories > Clothing' }
    }
  },
  {
    column: 'K',
    key: 'fb_product_category',
    description:
      '# Необязательно | The Facebook product category for the item. Learn more about product categories: https://www.facebook.com/business/help/526764014610932.',
    source: {
      kind: 'rowDetail',
      detail: 'fbCategory',
      fallback: { t: 'string', v: 'Clothing & Accessories > Clothing' }
    }
  },
  {
    column: 'L',
    key: 'quantity_to_sell_on_facebook',
    description:
      "# Необязательно | The quantity of this item you have to sell on Facebook and Instagram with checkout. Must be 1 or higher or the item won't be buyable",
    source: { kind: 'rowDetail', detail: 'quantity', fallback: { t: 'number', v: 75 } }
  },
  {
    column: 'M',
    key: 'sale_price',
    description:
      "# Необязательно | The discounted price of the item if it's on sale. Format the price as a number followed by the 3-letter currency code (ISO 4217 standards). Use a period (.) as the decimal point; don't use a comma. A sale price is required if you want to use an overlay for discounted prices.",
    source: { kind: 'rowDetail', detail: 'salePrice', fallback: { t: 'string', v: '' } }
  },
  {
    column: 'N',
    key: 'sale_price_effective_date',
    description:
      "# Необязательно | The time range for your sale period. Includes the date and time/time zone when your sale starts and ends. If this field is blank any items with a sale_price remain on sale until you remove the sale price. Use this format: YYYY-MM-DDT23:59+00:00/YYYY-MM-DDT23:59+00:00. Enter the start date as YYYY-MM-DD. Enter a 'T'. Enter the start time in 24-hour format (00:00 to 23:59) followed by the UTC time zone (-12:00 to +14:00). Enter '/' and then repeat the same format for your end date and time. The example row below uses PST time zone (-08:00).",
    source: { kind: 'rowDetail', detail: 'saleWindow', fallback: { t: 'string', v: '' } }
  },
  {
    column: 'O',
    key: 'item_group_id',
    description:
      '# Необязательно | Use this field to create variants of the same item. Enter the same group ID for all variants within a group. Learn more about variants: https://www.facebook.com/business/help/2256580051262113 Character limit: 100.',
    source: { kind: 'fixed', cell: { t: 'string', v: '' } }
  },
  {
    column: 'P',
    key: 'gender',
    description:
      '# Необязательно | Пол человека; на которого рассчитан этот товар. | Поддерживаемые значения: female; male; unisex',
    source: { kind: 'rowDetail', detail: 'gender', fallback: { t: 'string', v: 'unisex' } }
  },
  {
    column: 'Q',
    key: 'color',
    description:
      "# Необязательно | The color of the item. Use one or more words to describe the color. Don't use a hex code. Character limit: 200.",
    source: { kind: 'rowDetail', detail: 'color', fallback: { t: 'string', v: 'royal blue' } }
  },
  {
    column: 'R',
    key: 'size',
    description:
      '# Необязательно | The size of the item written as a word or abbreviation or number. For example: small; XL; 12. Character limit: 200.',
    source: { kind: 'rowDetail', detail: 'size', fallback: { t: 'string', v: 'M' } }
  },
  {
    column: 'S',
    key: 'age_group',
    description:
      '# Необязательно | Возрастная группа; на которую рассчитан товар. | Поддерживаемые значения: adult; all ages; infant; kids; newborn; teen; toddler',
    source: { kind: 'fixed', cell: { t: 'string', v: 'adult' } }
  },
  {
    column: 'T',
    key: 'material',
    description:
      '# Необязательно | Материал; из которого изготовлен товар; например хлопок; деним или кожа. Лимит: 200\u00a0символов.',
    source: { kind: 'rowDetail', detail: 'material', fallback: { t: 'string', v: 'cotton' } }
  },
  {
    column: 'U',
    key: 'pattern',
    description:
      '# Необязательно | The pattern or graphic print on the item. Character limit: 100.',
    source: { kind: 'rowDetail', detail: 'pattern', fallback: { t: 'string', v: 'stripes' } }
  },
  {
    column: 'V',
    key: 'shipping',
    description:
      '# Необязательно | Информация о доставке товара в следующем формате: "Страна:Регион:Служба:Цена". В цене следует указать 3-буквенный код валюты по стандарту ISO 4217. Чтобы использовать в рекламе оверлей "Бесплатная доставка"; для цены доставки укажите значение "0.0". Данные о доставке в разные регионы или страны нужно отделять точкой с запятой (";") или запятой (";"). Только люди из определенного региона или страны увидят информацию о доставке в этот регион или страну. Если данные о доставке для всей страны одинаковы; регион можно не указывать (оставьте последовательность символов "::").',
    source: {
      kind: 'rowDetail',
      detail: 'shipping',
      fallback: { t: 'string', v: 'US:CA:Ground:9.99 USD;US:NY:Air:15.99 USD' }
    }
  },
  {
    column: 'W',
    key: 'shipping_weight',
    description:
      '# Необязательно | The shipping weight of the item. Include the unit of measurement (lb/oz/g/kg).',
    source: { kind: 'rowDetail', detail: 'shippingWeight', fallback: { t: 'string', v: '10 kg' } }
  },
  {
    column: 'X',
    key: 'offer_disclaimer',
    description:
      '# Необязательно | Legal disclaimer text for product offers. This text provides important legal or regulatory information that must be displayed with the product offer. For example: "Valid while supplies last. Terms and conditions apply."',
    source: { kind: 'blank' }
  },
  {
    column: 'Y',
    key: 'offer_disclaimer_url',
    description:
      '# Необязательно | URL linking to the full disclaimer text. This provides a link to a page containing the complete disclaimer information for the product offer. For example: "https://example.com/terms-and-conditions"',
    source: { kind: 'blank' }
  },
  {
    column: 'Z',
    key: 'video[0].url',
    description:
      '# Необязательно | URL видео о товаре. Добавьте ссылку на видеофайл в файловом хранилище; а не на видеопроигрыватель. Поддерживаемые форматы видео: .3g2; .3gp; .3gpp; .asf; .avi; .dat; .divx; .dv; .f4v; .flv; .gif; .m2ts; .m4v; .mkv; .mod; .mov; .mp4; .mpe; .mpeg; .mpeg4; .mpg; .mts; .nsv; .ogm; .ogv; .qt; .tod; .ts; .vob и .wmv.',
    source: { kind: 'videoLink' }
  },
  {
    column: 'AA',
    key: 'video[0].tag[0]',
    description:
      '# Необязательно | URL видео о товаре. Добавьте ссылку на видеофайл в файловом хранилище; а не на видеопроигрыватель. Поддерживаемые форматы видео: .3g2; .3gp; .3gpp; .asf; .avi; .dat; .divx; .dv; .f4v; .flv; .gif; .m2ts; .m4v; .mkv; .mod; .mov; .mp4; .mpe; .mpeg; .mpeg4; .mpg; .mts; .nsv; .ogm; .ogv; .qt; .tod; .ts; .vob и .wmv.',
    source: { kind: 'rowDetail', detail: 'videoTag', fallback: { t: 'string', v: 'Gym' } }
  },
  {
    column: 'AB',
    key: 'gtin',
    description:
      '# Необязательно | Международный торговый код товара (GTIN). Рекомендуется для классификации товара. Может отображаться на штрихкоде; упаковке или обложке книги. Указывайте GTIN только в том случае; если вы уверены в его правильности. К типам GTIN относятся UPC (12 цифр); EAN (13 цифр); JAN (8 или 13 цифр); ISBN (13 цифр) или ITF-14 (14 цифр)',
    source: { kind: 'blank' }
  },
  {
    column: 'AC',
    key: 'product_tags[0]',
    description:
      '# Необязательно | Add labels to products to help filter them into product sets. Max characters: 110 per label; 5000 labels per product',
    source: { kind: 'rowDetail', detail: 'tag0', fallback: { t: 'string', v: 'some_string' } }
  },
  {
    column: 'AD',
    key: 'product_tags[1]',
    description:
      '# Необязательно | Add labels to products to help filter them into product sets. Max characters: 110 per label; 5000 labels per product',
    source: { kind: 'rowDetail', detail: 'tag1', fallback: { t: 'string', v: 'other' } }
  },
  {
    column: 'AE',
    key: 'style[0]',
    description: '# Необязательно | Опишите стиль этого товара.',
    source: { kind: 'rowDetail', detail: 'style', fallback: { t: 'string', v: 'Bodycon' } }
  }
];

/**
 * The whole sheet as cells: the template's description row, its key row, then one row per
 * product. A row planned from the space's pools carries its own name, text, price, picture and
 * details (024, US21); one without falls back to the settings and to Meta's example values.
 *
 * Content IDs are made here rather than taken from the rows, so every write of a sheet — the
 * first one and every update after it — carries IDs no catalog has used before. The video link
 * gets a distinct query appended per row, as 022's `?v=001` did.
 */
export function buildProductCatalogRows(input: {
  settings: ProductCatalogSettingsValues;
  sourceLink: string;
  videoLink: string;
  count: number;
  /** Per-row values (024); a row without one repeats the settings. */
  rows?: readonly ProductCatalogRowValues[];
  /** A fresh content ID; injectable so a test can hold it still. */
  newId?: () => string;
}): Cell[][] {
  const text = (v: string): Cell => ({ t: 'string', v });
  const rows: Cell[][] = [
    PRODUCT_CATALOG_TEMPLATE.map(column => text(column.description)),
    PRODUCT_CATALOG_TEMPLATE.map(column => text(column.key))
  ];
  const newId = input.newId ?? (() => contentId());
  const settingCell = (setting: keyof ProductCatalogSettingsValues, index: number): Cell => {
    const values = input.rows?.[index - 1] ?? input.settings;
    return setting === 'price' ? text(formatPrice(values.price)) : text(values[setting]);
  };
  const detailCell = (detail: RowDetailSource, index: number, fallback: Cell): Cell => {
    const values = input.rows?.[index - 1];
    if (!values) return fallback;
    if (detail === 'tag0' || detail === 'tag1') {
      const tag = values.tags?.[detail === 'tag0' ? 0 : 1];
      return tag === undefined ? fallback : text(tag);
    }
    const value = values[detail];
    if (value === undefined) return fallback;
    if (detail === 'salePrice') return text(formatPrice(value as number));
    return typeof value === 'number' ? { t: 'number', v: value } : text(String(value));
  };
  for (let index = 1; index <= input.count; index += 1) {
    const byColumn = new Map<string, Cell>();
    const row = PRODUCT_CATALOG_TEMPLATE.map(column => {
      const source = column.source;
      let cell: Cell;
      switch (source.kind) {
        case 'contentId':
          cell = text(newId());
          break;
        case 'setting':
          cell = settingCell(source.setting, index);
          break;
        case 'sourceLink':
          cell = text(input.sourceLink);
          break;
        case 'copyOf':
          cell = byColumn.get(source.column) ?? text('');
          break;
        case 'videoLink': {
          const mark = input.rows?.[index - 1]?.videoParam ?? String(index).padStart(3, '0');
          cell = text(`${input.videoLink}?v=${mark}`);
          break;
        }
        case 'rowDetail':
          cell = detailCell(source.detail, index, source.fallback);
          break;
        case 'blank':
          cell = text('');
          break;
        case 'fixed':
          cell = source.cell;
          break;
      }
      byColumn.set(column.column, cell);
      return cell;
    });
    rows.push(row);
  }
  return rows;
}
