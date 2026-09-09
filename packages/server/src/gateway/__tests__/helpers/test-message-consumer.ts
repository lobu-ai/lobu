import type { MessagePayload } from "@lobu/core";
import type { AgentRuntimeSelection } from "../../../lobu/stores/sandbox-store.js";
import type { IMessageQueue } from "../../infrastructure/queue/index.js";
import type { DeploymentManager } from "../../orchestration/deployment-manager.js";
import { MessageConsumer } from "../../orchestration/message-consumer.js";

type RecordRunInput = (payload: MessagePayload, deploymentName: string) => Promise<void>;

/**
 * A `MessageConsumer` whose tooling fold is stubbed, for tests that drive
 * `handleMessage` with fakes and must NOT touch Postgres.
 *
 * `handleMessage` unconditionally resolves the conversation pin and connector
 * tooling through live database queries. Tests that only exercise routing /
 * ownership / model-gating pass fakes for the queue and deployment manager and
 * otherwise never open a database; these stubs keep those tests isolated from
 * the `conversations`, `agents`, `sandboxes`, and `connections` tables.
 */
export class TestMessageConsumer extends MessageConsumer {
  constructor(
    deploymentManager: DeploymentManager,
    queue: IMessageQueue = {} as IMessageQueue,
    recordRunInput: RecordRunInput = async () => {},
  ) {
    super(deploymentManager, queue, recordRunInput);
  }

  /** No connector tooling contribution — fake-based tests never need one. */
  protected async foldConnectorTooling(_data: MessagePayload): Promise<string> {
    return "";
  }

  /** No sandbox pin — individual pin tests override this with their outcome. */
  protected async resolveRuntimeSelection(): Promise<AgentRuntimeSelection> {
    return {};
  }
}
