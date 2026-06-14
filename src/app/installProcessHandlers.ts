import type { Logger } from '../logging/index.js';
import {
  safeErrorMessage,
  type AppRunner,
} from './AppRunner.js';

export interface ProcessHandlerTarget {
  exitCode?: number;
  on(
    event: string,
    listener: (...arguments_: unknown[]) => void,
  ): unknown;
  removeListener(
    event: string,
    listener: (...arguments_: unknown[]) => void,
  ): unknown;
}

export interface InstallProcessHandlersOptions {
  readonly app: AppRunner;
  readonly logger: Logger;
  readonly target?: ProcessHandlerTarget;
}

export type RemoveProcessHandlers = () => void;

export function installProcessHandlers(
  options: InstallProcessHandlersOptions,
): RemoveProcessHandlers {
  const target =
    options.target ?? (process as unknown as ProcessHandlerTarget);

  const stopForSignal =
    (signal: 'SIGINT' | 'SIGTERM') =>
    (): void => {
      requestStop(options.app, options.logger, target, signal);
    };
  const handleUncaughtException = (error: unknown): void => {
    handleFatal(
      options.app,
      options.logger,
      target,
      'uncaught_exception',
      error,
    );
  };
  const handleUnhandledRejection = (reason: unknown): void => {
    handleFatal(
      options.app,
      options.logger,
      target,
      'unhandled_rejection',
      reason,
    );
  };
  const handleSigint = stopForSignal('SIGINT');
  const handleSigterm = stopForSignal('SIGTERM');

  target.on('SIGINT', handleSigint);
  target.on('SIGTERM', handleSigterm);
  target.on('uncaughtException', handleUncaughtException);
  target.on('unhandledRejection', handleUnhandledRejection);

  return () => {
    target.removeListener('SIGINT', handleSigint);
    target.removeListener('SIGTERM', handleSigterm);
    target.removeListener(
      'uncaughtException',
      handleUncaughtException,
    );
    target.removeListener(
      'unhandledRejection',
      handleUnhandledRejection,
    );
  };
}

function handleFatal(
  app: AppRunner,
  logger: Logger,
  target: ProcessHandlerTarget,
  event: 'uncaught_exception' | 'unhandled_rejection',
  error: unknown,
): void {
  target.exitCode = 1;
  safeLog(logger, 'error', event, {
    error: safeErrorMessage(error),
  });
  requestStop(app, logger, target, event);
}

function requestStop(
  app: AppRunner,
  logger: Logger,
  target: ProcessHandlerTarget,
  reason: string,
): void {
  void app.stop(reason).catch((error: unknown) => {
    target.exitCode = 1;
    safeLog(logger, 'error', 'service_stop_failed', {
      reason,
      error: safeErrorMessage(error),
    });
  });
}

function safeLog(
  logger: Logger,
  level: 'error',
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Fatal handling must continue even if logging fails.
  }
}
