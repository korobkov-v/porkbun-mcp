import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPorkbunServer } from '../dist/server.js';

test('issue regressions through MCP with mocked HTTP', async () => {
  const original = globalThis.fetch;
  const requests = [];
  let status = 200, body = { status: 'SUCCESS' };
  globalThis.fetch = async (url, options) => {
    requests.push({url, ...options, body: JSON.parse(options.body)});
    return new Response(JSON.stringify(body), {status});
  };
  const server = createPorkbunServer({apiKey:'fixture',secretKey:'fixture',baseUrl:'https://fixture.invalid',getMuddy:true,enableDomainCreate:true});
  const client = new Client({name:'test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const call = (name,args) => client.callTool({name,arguments:args});
    const data = result => JSON.parse(result.content[0].text);
    const tools = await client.listTools();
    assert.equal(tools.tools.length,40);
    for (const tool of tools.tools) assert.equal(tool.inputSchema.additionalProperties,false);
    for (const name of ['dns_get_by_name_type','dns_edit_by_name_type','dns_delete_by_name_type']) {
      const result = await call(name,{domain:'example.com',type:'A',name:'bot',...(name.includes('edit')?{content:'198.51.100.7'}:{})});
      assert.equal(result.isError,true);
    }
    assert.equal((await call('dns_create',{domain:'example.com',type:'A',content:'198.51.100.7',subdomain:'bot'})).isError,true);
    assert.equal(requests.length,0);
    await call('dns_get_by_name_type',{domain:'example.com',type:'A',subdomain:'bot'});
    assert.ok(requests.at(-1).url.endsWith('/example.com/A/bot'));
    for (const [name,path] of [['dns_edit_by_name_type','editByNameType'],['dns_delete_by_name_type','deleteByNameType']]) {
      await call(name,{domain:'example.com',type:'A',subdomain:'bot',...(name.includes('edit')?{content:'198.51.100.7'}:{})});
      assert.ok(requests.at(-1).url.endsWith('/dns/'+path+'/example.com/A/bot'));
    }
    await call('dns_get_by_name_type',{domain:'example.com',type:'A',subdomain:''});
    assert.ok(requests.at(-1).url.endsWith('/example.com/A'));
    const args = {domain:'example.com',cost:798,agree_to_terms:true,confirm_apply:true};
    let count=requests.length;
    assert.equal(data(await call('domains_create',args)).dry_run,true);
    assert.equal(requests.length,count);
    const result = data(await call('domains_create',{...args,dry_run:false}));
    assert.equal(requests.at(-1).body.cost,798);
    assert.equal(result.response.status,'SUCCESS');
    count=requests.length;
    for (const extra of [{pay_with:'card'},{card_payment_id:'id'},{idempotency_key:'key'}]) {
      assert.equal((await call('domains_create',{...args,dry_run:false,...extra})).isError,true);
    }
    for (const overrides of [{confirm_apply:false},{agree_to_terms:false},{cost:7.98},{cost:'798'}]) {
      assert.equal((await call('domains_create',{...args,dry_run:false,...overrides})).isError,true);
    }
    assert.equal(requests.length,count);
  } finally {globalThis.fetch=original; await client.close(); await server.close();}
});

for (const gate of [{getMuddy:false,enableDomainCreate:true},{getMuddy:true,enableDomainCreate:false}]) {
  test('registration gates '+JSON.stringify(gate),async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>{assert.fail('HTTP must not be called');};
    const server=createPorkbunServer({apiKey:'fixture',secretKey:'fixture',baseUrl:'https://fixture.invalid',...gate});
    const client=new Client({name:'gates',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const result=await client.callTool({name:'domains_create',arguments:{domain:'example.com',cost:798,agree_to_terms:true,confirm_apply:true,dry_run:false}});
      assert.equal(result.isError,true);
      if(!gate.getMuddy) {
        for(const name of ['dns_edit_by_name_type','dns_delete_by_name_type']) {
          assert.equal((await client.callTool({name,arguments:{domain:'example.com',type:'A',subdomain:'bot',...(name.includes('edit')?{content:'198.51.100.7'}:{})}})).isError,true);
        }
      }
    } finally {globalThis.fetch=original; await client.close(); await server.close();}
  });
}
