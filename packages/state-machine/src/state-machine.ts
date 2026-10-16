import { pino } from 'pino';
import type { DeviceState } from '@mayacardio/shared';
import { CloudHealthChecker, type HealthCheckOptions } from './health-checker.js';

export interface StateMachineOptions extends HealthCheckOptions {
  initialState?: DeviceState;
}

export class DeviceStateMachine {
  private currentState: DeviceState;
  private healthChecker: CloudHealthChecker;
  private logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  private stateChangeListeners: Array<(newState: DeviceState, oldState: DeviceState) => void> = [];

  constructor(options: StateMachineOptions) {
    this.currentState = options.initialState ?? 'offline';
    this.healthChecker = new CloudHealthChecker(options);

    this.healthChecker.onStatusChange((isHealthy) => {
      this.handleHealthChange(isHealthy);
    });
  }

  public getState(): DeviceState {
    return this.currentState;
  }

  public getHealthChecker(): CloudHealthChecker {
    return this.healthChecker;
  }

  public onStateChange(listener: (newState: DeviceState, oldState: DeviceState) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter((l) => l !== listener);
    };
  }

  public start(): void {
    this.healthChecker.start();
  }

  public stop(): void {
    this.healthChecker.stop();
  }

  public transitionTo(targetState: DeviceState): void {
    if (this.currentState === targetState) return;

    const oldState = this.currentState;
    this.currentState = targetState;
    this.logger.info({ oldState, newState: targetState }, `State transition: ${oldState} -> ${targetState}`);

    for (const listener of this.stateChangeListeners) {
      try {
        listener(targetState, oldState);
      } catch (err) {
        this.logger.error({ err }, 'Error in state change listener');
      }
    }
  }

  private handleHealthChange(isHealthy: boolean): void {
    if (isHealthy) {
      if (this.currentState === 'offline') {
        // When network returns from offline, move to RECOVERING first to catch up backlog
        this.transitionTo('recovering');
      }
    } else {
      if (this.currentState === 'online' || this.currentState === 'recovering') {
        // When network drops, move to OFFLINE
        this.transitionTo('offline');
      }
    }
  }

  /**
   * Called by the SyncWorker when all backlog and unacknowledged records have reconciled
   */
  public markCatchUpComplete(): void {
    if (this.currentState === 'recovering' && this.healthChecker.isHealthy()) {
      this.transitionTo('online');
    }
  }
}
