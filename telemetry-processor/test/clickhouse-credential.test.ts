import test from 'node:test';
import assert from 'node:assert/strict';
import {ClickHouseClient} from '../src/packages/exporters/clickhouse.js';

test('ClickHouse target may resolve one named environment credential without serializing its value',async()=>{
  process.env.SMPP_TEST_CLICKHOUSE_PASSWORD='test-only-value';
  process.env.SMPP_TEST_CLICKHOUSE_USER='test-only-user';
  try{
    const client=new ClickHouseClient({url:'http://127.0.0.1:1',userEnv:'SMPP_TEST_CLICKHOUSE_USER',passwordEnv:'SMPP_TEST_CLICKHOUSE_PASSWORD'});
    await client.initialize();
    await client.initialize();
    assert.equal(client.user,'test-only-user');
    assert.equal(client.password,'test-only-value');
    assert.equal(JSON.stringify({url:client.url,userEnv:client.userEnv,passwordEnv:client.passwordEnv}).includes('test-only-value'),false);
  }finally{delete process.env.SMPP_TEST_CLICKHOUSE_PASSWORD;delete process.env.SMPP_TEST_CLICKHOUSE_USER;}
});

test('ClickHouse credential source ambiguity and missing environment values fail closed',async()=>{
  await assert.rejects(()=>new ClickHouseClient({url:'http://127.0.0.1:1',password:'x',passwordEnv:'SMPP_TEST_MISSING'}).initialize(),/CLICKHOUSE_CREDENTIAL_AMBIGUOUS/);
  await assert.rejects(()=>new ClickHouseClient({url:'http://127.0.0.1:1',passwordEnv:'SMPP_TEST_MISSING'}).initialize(),/CLICKHOUSE_PASSWORD_ENV_MISSING/);
});
