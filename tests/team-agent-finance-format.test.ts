import { expect, it } from 'vitest';
import {
  financeDecimalComma,
  formatFinanceAmount
} from '../apps/web/src/team/accounts/finance/formatFinanceAmount';
it('hides only zero cents without numeric rounding or changing empty cells', () => {
  expect(formatFinanceAmount('45.00')).toBe('45');
  expect(formatFinanceAmount('0.00')).toBe('0');
  expect(formatFinanceAmount('45.25')).toBe('45,25');
  expect(formatFinanceAmount('45.10')).toBe('45,10');
  expect(formatFinanceAmount('999999999999999999.00')).toBe('999999999999999999');
  expect(formatFinanceAmount(null)).toBe('—');
  expect(formatFinanceAmount(null, '')).toBe('');
});
it('turns a typed dot into the comma and leaves the rest as typed', () => {
  expect(financeDecimalComma('32.43')).toBe('32,43');
  expect(financeDecimalComma('32,4')).toBe('32,4');
  expect(financeDecimalComma('12.')).toBe('12,');
});
