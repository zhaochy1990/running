import { CoordinatedTurnRunner, type TurnCoordinator } from "./coordinator.js";
import { InMemoryTurnState } from "./receiptStore.js";

export function createInMemoryTurnCoordinator(): TurnCoordinator {
  const state = new InMemoryTurnState();
  return new CoordinatedTurnRunner(state, state);
}
