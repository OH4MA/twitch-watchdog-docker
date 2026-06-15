import type { Page } from 'playwright';

import {
  LOG_EVENTS,
  redactSensitiveString,
  type LogFields,
} from '../logging/index.js';

export const DROP_CLAIM_CHECK_INTERVAL_MS = 60_000;

export type DropClaimResult =
  | {
      readonly status: 'claimed';
      readonly claimedAt: string;
      readonly claimedCount: number;
      readonly failedCount: number;
    }
  | {
      readonly status: 'not_found';
      readonly checkedAt: string;
    }
  | {
      readonly status: 'claim_failed';
      readonly checkedAt: string;
      readonly error: string;
    };

export interface DropClaimerLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export type DropClaimObserver = (
  result: DropClaimResult,
) => void | Promise<void>;

export interface DropClaimerOptions {
  readonly logger?: DropClaimerLogger;
  readonly now?: () => Date;
  readonly checkIntervalMs?: number;
  readonly onResult?: DropClaimObserver;
}

interface DropEvaluationResult {
  readonly eligibleCount: number;
  readonly claimedCount: number;
  readonly failedCount: number;
}

interface GraphqlDocument {
  readonly kind: 'Document';
  readonly definitions: readonly unknown[];
}

interface DropDocuments {
  readonly inventoryQuery: GraphqlDocument;
  readonly claimMutation: GraphqlDocument;
}

const NOOP_LOGGER: DropClaimerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const DROP_DOCUMENTS: DropDocuments = Object.freeze({
  inventoryQuery: createInventoryQuery(),
  claimMutation: createClaimMutation(),
});

export class DropClaimer {
  private readonly logger: DropClaimerLogger;
  private readonly now: () => Date;
  private readonly checkIntervalMs: number;
  private readonly onResult: DropClaimObserver | undefined;
  private lastCheckedAt: number | undefined;
  private claimFlight: Promise<DropClaimResult> | undefined;

  public constructor(options: DropClaimerOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.checkIntervalMs =
      options.checkIntervalMs ?? DROP_CLAIM_CHECK_INTERVAL_MS;
    this.onResult = options.onResult;

    if (
      !Number.isSafeInteger(this.checkIntervalMs) ||
      this.checkIntervalMs <= 0
    ) {
      throw new TypeError('checkIntervalMs must be a positive integer');
    }
  }

  public claimIfAvailable(page: Page): Promise<DropClaimResult> {
    const existingFlight = this.claimFlight;
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const checkedAt = this.now();
    if (
      this.lastCheckedAt !== undefined &&
      checkedAt.getTime() - this.lastCheckedAt < this.checkIntervalMs
    ) {
      return Promise.resolve({
        status: 'not_found',
        checkedAt: checkedAt.toISOString(),
      });
    }
    this.lastCheckedAt = checkedAt.getTime();

    const flight = this.runClaim(page, checkedAt);
    this.claimFlight = flight;
    flight.then(
      () => {
        if (this.claimFlight === flight) {
          this.claimFlight = undefined;
        }
      },
      () => {
        if (this.claimFlight === flight) {
          this.claimFlight = undefined;
        }
      },
    );
    return flight;
  }

  private async runClaim(
    page: Page,
    checkedAt: Date,
  ): Promise<DropClaimResult> {
    let evaluation: DropEvaluationResult;

    try {
      evaluation = await page.evaluate(
        claimDropsInPage,
        DROP_DOCUMENTS,
      );
    } catch (error: unknown) {
      const result: DropClaimResult = {
        status: 'claim_failed',
        checkedAt: checkedAt.toISOString(),
        error: safeErrorMessage(error),
      };
      safeLog(this.logger, 'warn', LOG_EVENTS.DROP_CLAIM_FAILED, {
        checkedAt: result.checkedAt,
        error: result.error,
      });
      this.notifyResult(result);
      return result;
    }

    if (evaluation.claimedCount === 0) {
      if (evaluation.failedCount > 0) {
        const result: DropClaimResult = {
          status: 'claim_failed',
          checkedAt: checkedAt.toISOString(),
          error: 'Twitch rejected one or more eligible drop claims',
        };
        safeLog(this.logger, 'warn', LOG_EVENTS.DROP_CLAIM_FAILED, {
          checkedAt: result.checkedAt,
          eligibleCount: evaluation.eligibleCount,
          failedCount: evaluation.failedCount,
          error: result.error,
        });
        this.notifyResult(result);
        return result;
      }

      return {
        status: 'not_found',
        checkedAt: checkedAt.toISOString(),
      };
    }

    const claimedAt = this.now().toISOString();
    const result: DropClaimResult = {
      status: 'claimed',
      claimedAt,
      claimedCount: evaluation.claimedCount,
      failedCount: evaluation.failedCount,
    };
    safeLog(this.logger, 'info', LOG_EVENTS.DROP_CLAIMED, {
      claimedAt,
      claimedCount: result.claimedCount,
      failedCount: result.failedCount,
    });
    if (result.failedCount > 0) {
      safeLog(this.logger, 'warn', 'drop_claim_partial_failure', {
        claimedCount: result.claimedCount,
        failedCount: result.failedCount,
      });
    }
    this.notifyResult(result);
    return result;
  }

  private notifyResult(result: DropClaimResult): void {
    try {
      void Promise.resolve(this.onResult?.(result)).catch(() => {
        safeLog(this.logger, 'warn', 'drop_notification_failed', {});
      });
    } catch {
      safeLog(this.logger, 'warn', 'drop_notification_failed', {});
    }
  }
}

async function claimDropsInPage(
  documents: DropDocuments,
): Promise<DropEvaluationResult> {
  type UnknownRecord = Record<string, unknown>;
  type ApolloClient = {
    query(options: UnknownRecord): Promise<UnknownRecord>;
    mutate(options: UnknownRecord): Promise<UnknownRecord>;
  };
  type BrowserDocument = {
    querySelector(selector: string): object | null;
  };

  const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const findApolloClient = (): ApolloClient | undefined => {
    const browserDocument = (
      globalThis as unknown as { readonly document: BrowserDocument }
    ).document;
    const rootElement = browserDocument.querySelector('#root');
    if (rootElement === null) {
      return undefined;
    }

    let reactRoot: unknown;
    for (const key in rootElement) {
      if (
        key.startsWith('_reactRootContainer') ||
        key.startsWith('__reactContainer$')
      ) {
        reactRoot = (rootElement as unknown as UnknownRecord)[key];
        break;
      }
    }

    if (isRecord(reactRoot) && isRecord(reactRoot._internalRoot)) {
      reactRoot = reactRoot._internalRoot.current;
    }
    if (!isRecord(reactRoot)) {
      return undefined;
    }

    const pending: Array<{ readonly node: UnknownRecord; readonly depth: number }> =
      [{ node: reactRoot, depth: 0 }];
    const visited = new Set<object>();

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current.node)) {
        continue;
      }
      visited.add(current.node);

      const pendingProps = current.node.pendingProps;
      if (isRecord(pendingProps) && isRecord(pendingProps.value)) {
        const client = pendingProps.value.client;
        if (
          isRecord(client) &&
          typeof client.query === 'function' &&
          typeof client.mutate === 'function'
        ) {
          return client as unknown as ApolloClient;
        }
      }

      if (current.depth >= 50) {
        continue;
      }
      for (const childName of ['child', 'sibling'] as const) {
        const child = current.node[childName];
        if (isRecord(child)) {
          pending.push({ node: child, depth: current.depth + 1 });
        }
      }
    }

    return undefined;
  };

  const client = findApolloClient();
  if (client === undefined) {
    throw new Error('Unable to locate Twitch Apollo client');
  }

  const response = await client.query({
    query: documents.inventoryQuery,
    variables: {},
    fetchPolicy: 'no-cache',
  });
  const data = response.data;
  const currentUser = isRecord(data) ? data.currentUser : undefined;
  const inventory = isRecord(currentUser)
    ? currentUser.inventory
    : undefined;
  const campaigns = isRecord(inventory)
    ? inventory.dropCampaignsInProgress
    : undefined;

  if (!isRecord(currentUser) || !Array.isArray(campaigns)) {
    return { eligibleCount: 0, claimedCount: 0, failedCount: 0 };
  }

  const userId = typeof currentUser.id === 'string' ? currentUser.id : '';
  let eligibleCount = 0;
  let claimedCount = 0;
  let failedCount = 0;

  for (const campaign of campaigns) {
    if (!isRecord(campaign) || !Array.isArray(campaign.timeBasedDrops)) {
      continue;
    }
    const campaignId =
      typeof campaign.id === 'string' ? campaign.id : '';

    for (const drop of campaign.timeBasedDrops) {
      if (!isRecord(drop) || !isRecord(drop.self)) {
        continue;
      }
      const requiredMinutes = drop.requiredMinutesWatched;
      const watchedMinutes = drop.self.currentMinutesWatched;
      if (
        drop.self.isClaimed === true ||
        drop.self.hasPreconditionsMet !== true ||
        typeof requiredMinutes !== 'number' ||
        typeof watchedMinutes !== 'number' ||
        watchedMinutes < requiredMinutes
      ) {
        continue;
      }

      const dropId = typeof drop.id === 'string' ? drop.id : '';
      const providedInstanceId = drop.self.dropInstanceID;
      const dropInstanceID =
        typeof providedInstanceId === 'string' &&
        providedInstanceId.length > 0
          ? providedInstanceId
          : userId !== '' && campaignId !== '' && dropId !== ''
            ? `${userId}#${campaignId}#${dropId}`
            : '';
      if (dropInstanceID === '') {
        continue;
      }

      eligibleCount += 1;
      try {
        await client.mutate({
          mutation: documents.claimMutation,
          variables: { input: { dropInstanceID } },
        });
        claimedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
  }

  return { eligibleCount, claimedCount, failedCount };
}

function createInventoryQuery(): GraphqlDocument {
  return documentNode([
    operationDefinition(
      'query',
      'WatchdogInventory',
      [],
      selectionSet([
        field('currentUser', [
          field('id'),
          field('inventory', [
            field('dropCampaignsInProgress', [
              field('id'),
              field('timeBasedDrops', [
                field('id'),
                field('requiredMinutesWatched'),
                field('self', [
                  field('isClaimed'),
                  field('currentMinutesWatched'),
                  field('dropInstanceID'),
                  field('hasPreconditionsMet'),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ),
  ]);
}

function createClaimMutation(): GraphqlDocument {
  return documentNode([
    operationDefinition(
      'mutation',
      'WatchdogClaimDrop',
      [
        {
          kind: 'VariableDefinition',
          variable: {
            kind: 'Variable',
            name: nameNode('input'),
          },
          type: {
            kind: 'NonNullType',
            type: {
              kind: 'NamedType',
              name: nameNode('ClaimDropRewardsInput'),
            },
          },
          directives: [],
        },
      ],
      selectionSet([
        {
          ...field('claimDropRewards', [field('status')]),
          arguments: [
            {
              kind: 'Argument',
              name: nameNode('input'),
              value: {
                kind: 'Variable',
                name: nameNode('input'),
              },
            },
          ],
        },
      ]),
    ),
  ]);
}

function documentNode(definitions: readonly unknown[]): GraphqlDocument {
  return { kind: 'Document', definitions };
}

function operationDefinition(
  operation: 'query' | 'mutation',
  operationName: string,
  variableDefinitions: readonly unknown[],
  operationSelectionSet: unknown,
): unknown {
  return {
    kind: 'OperationDefinition',
    operation,
    name: nameNode(operationName),
    variableDefinitions,
    directives: [],
    selectionSet: operationSelectionSet,
  };
}

function selectionSet(selections: readonly unknown[]): unknown {
  return { kind: 'SelectionSet', selections };
}

function field(
  fieldName: string,
  children?: readonly unknown[],
): Record<string, unknown> {
  return {
    kind: 'Field',
    name: nameNode(fieldName),
    arguments: [],
    directives: [],
    ...(children === undefined
      ? {}
      : { selectionSet: selectionSet(children) }),
  };
}

function nameNode(value: string): unknown {
  return { kind: 'Name', value };
}

function safeErrorMessage(error: unknown): string {
  let message = 'Unknown drop claim failure';
  try {
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = String(error);
    }
  } catch {
    message = 'Unserializable drop claim failure';
  }
  return redactSensitiveString(message);
}

function safeLog(
  logger: DropClaimerLogger,
  level: 'info' | 'warn',
  event: string,
  fields: LogFields,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Drop claiming must remain isolated from logging failures.
  }
}
