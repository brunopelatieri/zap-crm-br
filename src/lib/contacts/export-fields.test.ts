import { describe, expect, it } from 'vitest';
import {
  CONTACT_EXPORT_FIELDS,
  DEFAULT_CONTACT_EXPORT_FIELDS,
  LOCKED_CONTACT_EXPORT_FIELD,
  isContactExportFieldId,
  sortContactExportFields,
} from './export-fields';

describe('CONTACT_EXPORT_FIELDS', () => {
  it('phone é o único campo travado', () => {
    const locked = CONTACT_EXPORT_FIELDS.filter((f) => f.locked);
    expect(locked.map((f) => f.id)).toEqual(['phone']);
    expect(LOCKED_CONTACT_EXPORT_FIELD).toBe('phone');
  });

  it('name, phone, email e tags vêm marcados por padrão', () => {
    expect(DEFAULT_CONTACT_EXPORT_FIELDS).toEqual([
      'name',
      'phone',
      'email',
      'tags',
    ]);
  });
});

describe('isContactExportFieldId', () => {
  it('aceita apenas ids do catálogo', () => {
    expect(isContactExportFieldId('name')).toBe(true);
    expect(isContactExportFieldId('nope')).toBe(false);
  });
});

describe('sortContactExportFields', () => {
  it('reordena para a ordem canônica do catálogo, independente da entrada', () => {
    expect(sortContactExportFields(['email', 'name', 'phone'])).toEqual([
      'name',
      'phone',
      'email',
    ]);
  });

  it('força phone mesmo que o chamador não o inclua', () => {
    expect(sortContactExportFields(['name'])).toEqual(['name', 'phone']);
  });

  it('descarta duplicados', () => {
    expect(sortContactExportFields(['tags', 'tags', 'name'])).toEqual([
      'name',
      'phone',
      'tags',
    ]);
  });
});
