import { describe, expect, it } from 'vitest';
import {
  contentId,
  drawProductDetails,
  garmentOf,
  inventedBrand,
  pictureFacts,
  salePriceFor,
  saleWindowFrom
} from '../supabase/functions/_shared/product-details.js';

/**
 * Feature 024 (US21) — a catalog that reads as a shop, not as one product typed a hundred times.
 *
 * 022 wrote Meta's example into every row: royal blue, size M, cotton, "stripes", one barcode and
 * a sale that ended in 2020. Pinned here: what the name decides, the row follows; what nothing
 * decides is drawn; and a row never contradicts its own name.
 */

const steady = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length]!;
};

describe('what the name decides', () => {
  it('reads the garment, longest name first', () => {
    expect(garmentOf('Nova Sky Blue Tank Top')?.name).toBe('Tank Top');
    expect(garmentOf('Aurelia Linen Midi Dress')?.kind).toBe('dress');
    expect(garmentOf('Vera Denim Wide Leg Jeans')?.name).toBe('Wide Leg Jeans');
    expect(garmentOf('Rima Sage Pleated Skirt')?.kind).toBe('skirt');
    expect(garmentOf('Something Else Entirely')).toBeNull();
  });

  it('takes the colour and the fabric out of the name', () => {
    const details = drawProductDetails({
      title: 'Ludia Navy Twill Wide Leg Jeans',
      price: 20,
      brand: 'Ludia',
      random: () => 0.5
    });
    expect(details).toMatchObject({
      color: 'navy',
      material: 'twill',
      googleCategory: 'Apparel & Accessories > Clothing > Pants',
      fbCategory: 'Clothing & Accessories > Clothing > Pants',
      brand: 'Ludia',
      tags: ['wide-leg-jeans', 'navy']
    });
  });

  it('sells a dress and a skirt in the women’s section, and draws the rest', () => {
    const dress = drawProductDetails({
      title: 'Aurelia Ivory Linen Midi Dress',
      price: 20,
      brand: 'A',
      random: () => 0.99
    });
    expect(dress.gender).toBe('female');
    const shirt = drawProductDetails({
      title: 'Nova White Cotton Oxford Shirt',
      price: 20,
      brand: 'A',
      random: () => 0.99
    });
    expect(['female', 'male', 'unisex']).toContain(shirt.gender);
  });

  it('keeps every drawn value inside its own range', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const details = drawProductDetails({
        title: 'Nova Sage Jersey Hoodie',
        price: 30,
        brand: 'Nova',
        random: steady([seed / 50, ((seed * 7) % 50) / 50, ((seed * 13) % 50) / 50])
      });
      expect(['XS', 'S', 'M', 'L', 'XL', 'XXL']).toContain(details.size);
      expect(details.quantity).toBeGreaterThanOrEqual(20);
      expect(details.quantity).toBeLessThanOrEqual(300);
      expect(details.shippingWeight).toMatch(/^\d\.\d kg$/u);
      expect(details.shipping).toMatch(/^US::\w+:\d+\.\d\d USD$/u);
      expect(details.videoParam).toMatch(/^[0-9a-z]{4}$/u);
      expect(details.salePrice).toBeLessThan(30);
      expect(details.salePrice).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('what a picture’s file name says (024, US27)', () => {
  it('reads the owner’s naming: garment, colour, shot', () => {
    // The owner's own folder: `hoodie_black_01.jpg`, `tank-top_sage_01.jpg`, …
    const read = (name: string) => {
      const facts = pictureFacts(name);
      return `${facts.garment?.name ?? '-'}/${facts.color ?? '-'}`;
    };
    expect(read('hoodie_black_01.jpg')).toBe('Hoodie/black');
    expect(read('tank-top_sage_01.jpg')).toBe('Tank Top/sage');
    expect(read('oxford-shirt_ivory_01.jpg')).toBe('Oxford Shirt/ivory');
    expect(read('sweater_forest-green_01.jpg')).toBe('Sweater/forest green');
    expect(read('blouse_dusty-rose_01.jpg')).toBe('Blouse/dusty rose');
    // `tshirt` is how a file is named; `T-Shirt` is how the pool writes it.
    expect(read('tshirt_white_02.jpg')).toBe('T-Shirt/white');
    // A file named anything else says nothing, and the catalog behaves as it did before.
    expect(read('IMG_2031.png')).toBe('-/-');
  });

  it('takes the picture’s colour only where the name gives none', () => {
    expect(
      drawProductDetails({
        title: 'Ludia Navy Twill Wide Leg Jeans',
        price: 20,
        brand: 'A',
        pictureColor: 'black',
        random: () => 0.5
      }).color
    ).toBe('navy');
    expect(
      drawProductDetails({
        title: 'Ludia Twill Wide Leg Jeans',
        price: 20,
        brand: 'A',
        pictureColor: 'black',
        random: () => 0.5
      }).color
    ).toBe('black');
  });
});

describe('the price and the sale', () => {
  it('discounts, never to nothing and never up', () => {
    for (const price of [1, 2, 9, 30, 999]) {
      for (const draw of [0, 0.5, 0.999]) {
        const sale = salePriceFor(price, () => draw);
        expect(sale).toBeGreaterThanOrEqual(1);
        if (price > 1) expect(sale).toBeLessThan(price);
      }
    }
  });

  it('runs a sale that is running: from yesterday to a month out', () => {
    const now = Date.UTC(2026, 8, 18, 9, 0, 0);
    expect(saleWindowFrom(now)).toBe('2026-09-17T00:00+00:00/2026-10-18T23:59+00:00');
  });
});

describe('the content ID', () => {
  it('carries the time it was written and a drawn tail', () => {
    const at = Date.UTC(2026, 8, 18, 12, 0, 0);
    expect(contentId(at, () => 0)).toBe(`${at.toString(36).toUpperCase()}-0000000`);
    expect(contentId(at, () => 0.999)).toBe(`${at.toString(36).toUpperCase()}-ZZZZZZZ`);
  });

  it('does not repeat itself across a catalog’s worth of rows', () => {
    const ids = new Set(Array.from({ length: 4000 }, () => contentId()));
    expect(ids.size).toBe(4000);
  });
});

describe('the catalog’s brand', () => {
  it('is a made-up word, capitalized', () => {
    expect(inventedBrand(() => 0)).toBe('Auau');
    expect(inventedBrand(() => 0.9)).toMatch(/^[A-Z][a-z]+$/u);
  });
});
