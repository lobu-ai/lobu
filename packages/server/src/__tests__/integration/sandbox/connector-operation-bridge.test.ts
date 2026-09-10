import { describe, expect, it } from 'vitest';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';

const compiledCode = `class Connector {
  async sync(ctx) { const data = await ctx.operations.read('listItems', {query:{limit:2}}); return {events:[], checkpoint:data}; }
  async read(ctx) { const data = await ctx.operations.read('listItems', {query:{limit:2}}); return {rows:[data]}; }
  async execute(ctx) { return {success:true, output:await ctx.operations.read('listItems', {query:{limit:2}})}; }
} module.exports = {Connector};`;
const base = { config:{}, credentials:null, sessionState:null, env:{} };
describe('connection-bound operation bridge', () => {
  for (const mode of ['read', 'action', 'sync'] as const) {
    it(`forwards ${mode} calls over the isolate host capability`, async () => {
      let calls = 0;
      const job = mode === 'read' ? {...base, mode, feedKey:'items'} : mode === 'action' ? {...base,mode,actionKey:'summary',actionInput:{}} : {...base,mode,feedKey:'items',checkpoint:null,entityIds:[]};
      const result = await executeCompiledConnector({ compiledCode, job, hooks:{onReadOperation:async(key,input)=>{
        calls++; expect(key).toBe('listItems'); expect(input).toEqual({query:{limit:2}}); return {count:2};
      }}});
      expect(calls).toBe(1);
      expect(JSON.stringify(result)).toContain('"count":2');
    });
  }
  it('fails closed without a host binding', async () => {
    await expect(executeCompiledConnector({compiledCode,job:{...base,mode:'read',feedKey:'items'}})).rejects.toThrow('unavailable');
  });
});
