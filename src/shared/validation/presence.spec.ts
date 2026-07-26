import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validateSync } from 'class-validator';

import { IsOptionalNotNull } from './presence';

class Subject {
  @IsOptionalNotNull()
  @IsString()
  required?: string;

  @IsOptional()
  @IsString()
  clearable?: string | null;
}

const errorsOn = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(Subject, payload)).map((e) => e.property);

/**
 * The distinction these two decorators draw is the difference between a 422 and
 * a 500, so it is worth pinning at this level rather than only through HTTP.
 */
describe('IsOptionalNotNull', () => {
  it('skips validation when the key is absent, like IsOptional', () => {
    expect(errorsOn({})).toEqual([]);
  });

  it('rejects an explicit null, unlike IsOptional', () => {
    // The whole point: @IsOptional() would skip @IsString() here and let the
    // null through to a column that cannot hold one.
    expect(errorsOn({ required: null })).toEqual(['required']);
  });

  it('still validates a present value', () => {
    expect(errorsOn({ required: 'ok' })).toEqual([]);
    expect(errorsOn({ required: 42 })).toEqual(['required']);
  });

  it('leaves undefined alone even when passed explicitly', () => {
    expect(errorsOn({ required: undefined })).toEqual([]);
  });

  describe('contrasted with IsOptional on a genuinely nullable field', () => {
    it('accepts null, because null is how the caller clears it', () => {
      expect(errorsOn({ clearable: null })).toEqual([]);
    });

    it('accepts absence', () => {
      expect(errorsOn({ clearable: undefined })).toEqual([]);
    });

    it('still rejects a wrong-typed value', () => {
      expect(errorsOn({ clearable: 42 })).toEqual(['clearable']);
    });
  });

  it('reports both fields independently', () => {
    expect(errorsOn({ required: null, clearable: 42 }).sort()).toEqual(['clearable', 'required']);
  });
});
