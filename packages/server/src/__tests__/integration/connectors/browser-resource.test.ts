import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { compileConnectorSource, extractConnectorMetadata, validateConnectorMetadata } from '../../../utils/connector-compiler';
import { selectedBrowserRequirement } from '../../../connectors/browser-resource';

const browser = { origins: ['https://source.example'], authMethods: ['browser'], accountProbe: {url:'https://source.example/account',expression:'null'} };
const source = `
import { defineConnector, requireBrowser } from '@lobu/connector-sdk';
export default defineConnector({
 key: 'browser-resource-fixture', name: 'Browser resource fixture', version: '1.0.0',
 browser: ${JSON.stringify(browser)}, authSchema: { methods: [{type:'browser',mode:'live'}] },
 actions: {
  inspect: {name:'Inspect',kind:'read',execute:async ctx => ({success:true,output:{hasBrowser:!!ctx.browser}})},
  read: {name:'Read',kind:'read',execute:async ctx => ({success:true,output:await requireBrowser(ctx).dispatch('navigate',ctx.input)})},
  bypass: {name:'Bypass',kind:'read',execute:async () => ({success:true,output:JSON.parse(await globalThis.__lobuHost.async('dispatchChromeAction','evaluate',JSON.stringify({expression:'1',allowed_origins:['*']})))})}
 }
});`;
let code: string;
const job = { mode: 'action' as const, actionKey: 'inspect', actionInput: {}, config: {}, credentials: null,
 sessionState: null, env: {} };

describe('browser resource host contract', () => {
 beforeAll(async () => { code = (await compileConnectorSource(source)).compiledCode; });
 it('extracts one declared grant and the gateway verification operation', async () => {
  const metadata = await extractConnectorMetadata(code);
  expect(metadata.browser).toEqual(browser);
 expect(metadata.actions?.verify_browser).toMatchObject({kind:'read'});
  expect(() => validateConnectorMetadata(metadata)).not.toThrow();
  expect(() => validateConnectorMetadata({...metadata, browser: null})).toThrow(/account probe/);
  expect(() => validateConnectorMetadata({...metadata, browser: {...browser, accountProbe: undefined}})).toThrow(/account probe/);
  expect(() => validateConnectorMetadata({...metadata, browser: {...browser, authMethods: ['oauth']}})).toThrow(/authentication method/);
  expect(selectedBrowserRequirement(browser, {methods:[{type:'oauth'},{type:'browser',mode:'live'}]}, 'oauth_account')).toBeNull();
  expect(selectedBrowserRequirement(browser, {methods:[{type:'oauth'},{type:'browser',mode:'live'}]})).toBeNull();
 });
 it('exposes no browser when no host grant was issued', async () => {
  const hook = vi.fn();
  const result = await new IsolateExecutor().execute(code, job, {onChromeDispatch:hook});
  expect(result).toMatchObject({output:{hasBrowser:false}});
  expect(hook).not.toHaveBeenCalled();
 });
 it('rejects raw host calls even when a bridge hook exists', async () => {
  const hook = vi.fn();
  await expect(new IsolateExecutor().execute(code, {...job,actionKey:'bypass'}, {onChromeDispatch:hook})).rejects.toThrow(/not granted/);
  expect(hook).not.toHaveBeenCalled();
 });
 it('overrides widening attempts at the host boundary, including raw calls', async () => {
  const hook = vi.fn(async (_key,input) => input);
  const result = await new IsolateExecutor().execute(code, {...job,actionKey:'bypass',browser}, {onChromeDispatch:hook});
  expect(result).toMatchObject({output:{allowed_origins:browser.origins}});
  expect(hook).toHaveBeenCalledExactlyOnceWith('evaluate',{expression:'1',allowed_origins:browser.origins});
 });
 it('refuses undeclared destinations before dispatching a browser step', async () => {
  const hook = vi.fn();
  await expect(new IsolateExecutor().execute(code, {...job,actionKey:'read',browser,actionInput:{url:'https://outside.example/'}}, {onChromeDispatch:hook})).rejects.toThrow(/outside/);
  expect(hook).not.toHaveBeenCalled();
 });
 it('does not let connector code implement the reserved verification operation', async () => {
  const reserved = await compileConnectorSource(source.replace('inspect: {', 'verify_browser: {'));
  await expect(extractConnectorMetadata(reserved.compiledCode)).rejects.toThrow(/reserved/);
 });
});
