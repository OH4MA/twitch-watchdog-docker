import { parseDocument, type YAMLError } from 'yaml';

import { ConfigParseError } from './errors.js';

export function parseYaml(source: string): unknown {
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    const parseError = document.errors[0];

    if (parseError !== undefined) {
      throw createSafeParseError(parseError);
    }

    const value = document.toJS();
    assertAcyclic(value, new WeakSet<object>());
    return value;
  } catch (error: unknown) {
    if (error instanceof ConfigParseError) {
      throw error;
    }

    throw new ConfigParseError('YAML 語法無效');
  }
}

function assertAcyclic(
  value: unknown,
  ancestors: WeakSet<object>,
): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (ancestors.has(value)) {
    throw new ConfigParseError('YAML 不可包含循環 alias');
  }

  ancestors.add(value);
  for (const child of Object.values(value)) {
    assertAcyclic(child, ancestors);
  }
  ancestors.delete(value);
}

function createSafeParseError(error: YAMLError): ConfigParseError {
  const line = error.linePos?.[0].line;
  return new ConfigParseError(
    line === undefined ? 'YAML 語法無效' : `YAML 第 ${line} 行語法無效`,
  );
}
