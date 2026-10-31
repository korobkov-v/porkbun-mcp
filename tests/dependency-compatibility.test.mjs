import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPorkbunServer } from '../dist/server.js';

test('updated SDK/Zod preserve nested strictness, collection bounds and optional arguments',async()=>{
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({status:'SUCCESS',records:[]}));};
 const server=createPorkbunServer({apiKey:'fixture',secretKey:'fixture',baseUrl:'https://fixture.invalid',getMuddy:true,enableDomainCreate:true});
 const client=new Client({name:'compatibility',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const call=(name,args)=>client.callTool({name,arguments:args});
  for(const [name,args] of [
   ['domains_check_bulk',{domains:Array(101).fill('example.com')}],
   ['domains_check_bulk',{domains:[]}],
   ['dns_query',{domain:'example.com',selector:{type:'A',name:'bot'}}],
   ['dns_batch_apply',{domain:'example.com',desired_records:[{type:'A',content:'192.0.2.1',name:'bot'}]}],
   ['domains_create',{domain:'example.com',cost:Number.MAX_SAFE_INTEGER+1,agree_to_terms:true}]
  ]) assert.equal((await call(name,args)).isError,true);
  assert.equal(requests,0);
  assert.equal((await call('dns_query',{domain:'example.com',selector:{type:'A'}})).isError,undefined);
  assert.equal(requests,1);
  const list=await client.listTools();
  const bulk=list.tools.find(x=>x.name==='domains_check_bulk');
  assert.equal(bulk.inputSchema.properties.domains.maxItems,100);
  assert.equal(bulk.inputSchema.additionalProperties,false);
 } finally {globalThis.fetch=original;await client.close();await server.close();}
});
