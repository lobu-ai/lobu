/** ClientSDK inference-provider management delegates to the shared action runner. */
import type {
  InferenceProviderCreateInput, InferenceProviderUpdateInput,
  InferenceProviderSetDefaultInput, InferenceProviderSetCapabilityInput,
  InferenceProviderRotateKeyInput, InferenceProviderDeleteInput,
  InferenceProviderListResult, InferenceProviderCreateResult,
  InferenceProviderUpdateResult, InferenceProviderDefaultResult, InferenceProviderSuccess,
} from '@lobu/core/contracts/tools/manage-inference-providers';
import type { Env } from '../../index';
import type { ToolContext } from '../../tools/registry';
import { manageInferenceProviders } from '../../tools/admin/manage_inference_providers';
import { createActionCaller } from './action-call';

export interface InferenceProvidersNamespace {
  list(): Promise<InferenceProviderListResult>;
  create(input: InferenceProviderCreateInput): Promise<InferenceProviderCreateResult>;
  update(input: InferenceProviderUpdateInput): Promise<InferenceProviderUpdateResult>;
  setDefault(input: InferenceProviderSetDefaultInput): Promise<InferenceProviderDefaultResult>;
  setCapability(input: InferenceProviderSetCapabilityInput): Promise<InferenceProviderUpdateResult>;
  rotateKey(input: InferenceProviderRotateKeyInput): Promise<InferenceProviderSuccess>;
  delete(input: InferenceProviderDeleteInput): Promise<InferenceProviderSuccess>;
}

export function buildInferenceProvidersNamespace(ctx: ToolContext, env: Env): InferenceProvidersNamespace {
  const { method } = createActionCaller(manageInferenceProviders, env, ctx, 'inferenceProviders');
  return {
    list: method('list', { publicMethod: 'list' }),
    create: method('create', { publicMethod: 'create' }),
    update: method('update', { publicMethod: 'update' }),
    setDefault: method('set_default', { publicMethod: 'setDefault' }),
    setCapability: method('set_capability', { publicMethod: 'setCapability' }),
    rotateKey: method('rotate_key', { publicMethod: 'rotateKey' }),
    delete: method('delete', { publicMethod: 'delete' }),
  };
}
