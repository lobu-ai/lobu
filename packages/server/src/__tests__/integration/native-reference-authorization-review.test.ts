import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestConnection, createTestConnectorDefinition, createTestOrganization, createTestUser, createTestOAuthClient, createTestAccessToken } from '../setup/test-fixtures';
import { TestApiClient } from '../setup/test-mcp-client';
import { post } from '../setup/test-helpers';
describe('native reference actual REST authorization review', () => {
 let publicSlug:string, privateSlug:string, id:string, visibleId:number, hiddenId:number;
 let ownerApi: Awaited<ReturnType<typeof TestApiClient.for>>;
 let aToken:string,bToken:string;
 beforeAll(async () => {
  await cleanupTestDatabase();
  const pub=await createTestOrganization({name:'Reference public fixture',visibility:'public'});
  const priv=await createTestOrganization({name:'Reference private fixture',visibility:'private'});
  publicSlug=pub.slug; privateSlug=priv.slug;
  const user=await createTestUser({email:'reference-authorization@example.test'});
  await addUserToOrganization(user.id,pub.id,'owner');
  const other=await createTestUser({email:'reference-other@example.test'});
  await addUserToOrganization(other.id,priv.id,'owner');
  const oauth=await createTestOAuthClient();
  aToken=(await createTestAccessToken(user.id,pub.id,oauth.client_id,{scope:'mcp:read'})).token;
  bToken=(await createTestAccessToken(other.id,priv.id,oauth.client_id,{scope:'mcp:read'})).token;
  const agent=await createTestAgent({organizationId:pub.id,ownerUserId:user.id,agentId:'visible-reference-agent'});
  await createTestConnectorDefinition({key:'reference.demo',name:'Reference fixture connector',organization_id:pub.id});
  const visible=await createTestConnection({organization_id:pub.id,connector_key:'reference.demo',visibility:'org',created_by:user.id});
  const hidden=await createTestConnection({organization_id:pub.id,connector_key:'reference.demo',visibility:'private',created_by:user.id});
  visibleId=Number(visible.id);hiddenId=Number(hidden.id);
  ownerApi=await TestApiClient.for({organizationId:pub.id,userId:user.id,memberRole:'owner'});
  const created=await ownerApi.automations.create({slug:'reference-test',name:'Public reference',prompt:'Fixture',managed_agent_id:agent.agentId}) as {automation_id:string};
  id=String(created.automation_id);
 });
 it('enforces real public/private scope for the selected reads', async () => {
  const req=async (org:string,tool:string,body:object)=>post(`/api/${org}/${tool}`,{body});
  const a=await req(publicSlug,'manage_automations',{action:'list',automation_id:id,status:'active',include_details:false,limit:1});
  const aj=await a.json();expect(a.status).toBe(200);expect(aj.automations.map((x:{automation_id:string})=>String(x.automation_id))).toEqual([id]);
  const c=await req(publicSlug,'manage_connections',{action:'list',connection_ids:[visibleId,hiddenId],connector_key:'reference.demo',limit:5});
  const cj=await c.json();expect(c.status).toBe(200);expect(cj.connections.map((x:{id:number})=>Number(x.id))).toContain(visibleId);expect(cj.connections.map((x:{id:number})=>Number(x.id))).not.toContain(hiddenId);
  const g=await req(publicSlug,'manage_agents',{action:'get',agent_id:'visible-reference-agent'});const gj=await g.json();expect(g.status).toBe(200);expect(gj.agent.id).toBe('visible-reference-agent');
  const catalog=await req(publicSlug,'manage_catalog',{action:'list_installed',kinds:['connectors'],include_catalog:true});expect(catalog.status).toBe(200);
  for(const [tool,body] of [['manage_automations',{action:'list',automation_id:id,status:'active',limit:1}],['manage_connections',{action:'list',connection_ids:[visibleId],connector_key:'reference.demo',limit:1}],['manage_agents',{action:'get',agent_id:'visible-reference-agent'}],['manage_catalog',{action:'list_installed',kinds:['connectors'],include_catalog:true}]] as const){const r=await req(privateSlug,tool,body);expect([401,403]).toContain(r.status);}
  const absent=await req(publicSlug,'manage_automations',{action:'list',automation_id:'999999',status:'active',limit:1});expect((await absent.json()).automations).toEqual([]);
  await ownerApi.automations.delete({automation_ids:[id]});
  const defaultList = await req(publicSlug,'manage_automations',{action:'list',automation_id:id,limit:1});
  expect((await defaultList.json()).automations).toEqual([]);
  const activeList = await req(publicSlug,'manage_automations',{action:'list',automation_id:id,status:'active',limit:1});
  expect((await activeList.json()).automations).toEqual([]);
  const archivedList = await req(publicSlug,'manage_automations',{action:'list',automation_id:id,status:'archived',limit:1});
  const archived = (await archivedList.json()).automations;
  expect(archived.map((x:{automation_id:string})=>String(x.automation_id))).toEqual([id]);
  expect(archived[0].status).toBe('archived');
 });
 it('denies an authenticated principal outside its workspace and does not resolve foreign IDs within its own workspace',async()=>{
  const specs=[
   ['manage_automations',{action:'list',automation_id:id,status:'archived',limit:1}],
   ['manage_connections',{action:'list',connection_ids:[visibleId],connector_key:'reference.demo',limit:1}],
   ['manage_agents',{action:'get',agent_id:'visible-reference-agent'}],
   ['manage_catalog',{action:'list_installed',kinds:['connectors'],include_catalog:true}],
  ] as const;
  const cross=[];
  for(const [tool,body] of specs){
   const r=await post(`/api/${privateSlug}/${tool}`,{body,token:aToken});
   cross.push(r.status);expect([401,403]).toContain(r.status);
  }
  const a=await post(`/api/${privateSlug}/manage_automations`,{token:bToken,body:specs[0][1]});
  expect(a.status).toBe(200);expect((await a.json()).automations).toEqual([]);
  const c=await post(`/api/${privateSlug}/manage_connections`,{token:bToken,body:specs[1][1]});
  expect(c.status).toBe(200);expect((await c.json()).connections).toEqual([]);
  const g=await post(`/api/${privateSlug}/manage_agents`,{token:bToken,body:specs[2][1]});
  expect([403,404]).toContain(g.status);
 });

});
