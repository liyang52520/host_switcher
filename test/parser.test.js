// parser.test.js - 直接测试 parser.js 的纯函数，无需 vm 沙箱或 DOM mock
'use strict';

const { parseBatchText, parseBatchLine, compileActiveRules } = require('../extension/lib/parser');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, '\n     got :', JSON.stringify(got), '\n     want:', JSON.stringify(want)); }
}

console.log('== parseBatchLine basics ==');
eq('blank', parseBatchLine('', 1), { kind: 'blank' });
eq('comment #', parseBatchLine('# hello', 2), { kind: 'comment' });
eq('comment //', parseBatchLine('// hi', 3), { kind: 'comment' });
eq('whitespace-only', parseBatchLine('   ', 4), { kind: 'blank' });
eq('only one column (no separator)', parseBatchLine('foo', 5).kind, 'error');
eq('only one column (whitespace split)', parseBatchLine('10.0.0.1', 6).kind, 'error');
eq('three columns', parseBatchLine('10.0.0.1 a b', 7).kind, 'error');
eq('port not number (hosts)', parseBatchLine('10.0.0.1:abc example.com', 8).kind, 'error');

console.log('\n== hosts-style parsing ==');
const h1 = parseBatchLine('198.51.100.2  internal-svc.example.com', 1);
eq('h1 kind', h1.kind, 'rule');
eq('h1 match host', h1.rule.matchHost, 'internal-svc.example.com');
eq('h1 match port', h1.rule.matchPort, '');
eq('h1 target host', h1.rule.targetHost, '198.51.100.2');
eq('h1 target port', h1.rule.targetPort, '');
eq('h1 enabled', h1.rule.enabled, true);

const h2 = parseBatchLine('198.51.100.2:31015\tinternal-svc.example.com:31015', 1);
eq('h2 match host', h2.rule.matchHost, 'internal-svc.example.com');
eq('h2 match port', h2.rule.matchPort, '31015');
eq('h2 target host', h2.rule.targetHost, '198.51.100.2');
eq('h2 target port', h2.rule.targetPort, '31015');

const h3 = parseBatchLine('   10.0.0.5    api.example.com   ', 1);
eq('h3 trim match host', h3.rule.matchHost, 'api.example.com');
eq('h3 trim target host', h3.rule.targetHost, '10.0.0.5');

const h4 = parseBatchLine('10.0.0.1:443  example.com:8443', 1);
eq('h4 match host', h4.rule.matchHost, 'example.com');
eq('h4 match port', h4.rule.matchPort, '8443');
eq('h4 target host', h4.rule.targetHost, '10.0.0.1');
eq('h4 target port', h4.rule.targetPort, '443');

const h5 = parseBatchLine('10.0.0.1  localhost', 1);
eq('h5 localhost match', h5.kind, 'rule');
eq('h5 localhost host', h5.rule.matchHost, 'localhost');

const h6 = parseBatchLine('10.0.0.1  *.example.com', 1);
eq('h6 wildcard rejected (proxy 不支持通配)', h6.kind, 'error');

const h6b = parseBatchLine('10.0.0.1  *.', 1);
eq('h6b bare wildcard rejected', h6b.kind, 'error');

const h7 = parseBatchLine('10.0.0.1  -bad-.com', 1);
eq('h7 bad host format', h7.kind, 'error');

const h8 = parseBatchLine('', null, 1);
eq('h8 null rawLine', h8.kind, 'blank');

const h9 = parseBatchLine('10.0.0.1  ', 1);
eq('h9 missing match column', h9.kind, 'error');

const h10 = parseBatchLine('10.0.0.1  myserver', 1);
eq('h10 single-label hostname accepted', h10.kind, 'rule');
eq('h10 single-label host', h10.rule.matchHost, 'myserver');

const h11 = parseBatchLine('10.0.0.1  -bad-.com', 1);
eq('h11 leading dash rejected', h11.kind, 'error');

const h12 = parseBatchLine('999.999.999.999  example.com', 1);
eq('h12 ipv4 out of range rejected', h12.kind, 'error');

const h13 = parseBatchLine('01.02.03.04  example.com', 1);
eq('h13 ipv4 leading zero rejected', h13.kind, 'error');

console.log('\n== parseBatchText 混合 ==');
const text = `# 示例：内网测试环境
198.51.100.1  internal-api.example.com
198.51.100.2:8443  internal-svc.example.com:443
// 注释行
   10.0.0.1:443    secure.example.com:8443

# 错误行
bad-line-no-separator
10.0.0.1 a b c
1.2.3.4:abc example.com
`;
const parsed = parseBatchText(text);
eq('mixed rules count', parsed.rules.length, 3);
eq('mixed errors count', parsed.errors.length, 3);
eq('error[0] lineNo', parsed.errors[0].lineNo, 8);
eq('error[1] lineNo', parsed.errors[1].lineNo, 9);
eq('error[2] lineNo', parsed.errors[2].lineNo, 10);

eq('rule[0] match host', parsed.rules[0].matchHost, 'internal-api.example.com');
eq('rule[0] target host', parsed.rules[0].targetHost, '198.51.100.1');
eq('rule[1] match port', parsed.rules[1].matchPort, '443');
eq('rule[1] target port', parsed.rules[1].targetPort, '8443');
eq('rule[2] target port', parsed.rules[2].targetPort, '443');
eq('rule[2] match port', parsed.rules[2].matchPort, '8443');

eq('parseBatchText null safe', parseBatchText(null).rules.length, 0);

console.log('\n== compileActiveRules 多组合并去重 ==');
const groups = [
  { id: 'g1', name: 'Staging', enabled: true,
    content: '198.51.100.1  internal-api.example.com\n198.51.100.2:8443  internal-svc.example.com:443' },
  { id: 'g2', name: 'Production', enabled: false,
    content: '10.0.0.1  api.example.com' },
  { id: 'g3', name: '重叠组', enabled: true,
    content: '198.51.100.1  internal-api.example.com\n10.0.0.2  other.example.com' },
  { id: 'g4', name: '有错误行', enabled: true,
    content: '10.0.0.5  good.example.com\n10.0.0.1  -bad-.com\n10.0.0.6:abc badhost' },
  null,
  { id: 'g5', name: '非对象' },
];
const compiled = compileActiveRules(groups);
eq('compiled rules count (g1*2 + g3 去重1 + g4*1)', compiled.rules.length, 4);
eq('compiled errors count', compiled.errors.length, 2);
eq('first rule match host', compiled.rules[0].matchHost, 'internal-api.example.com');
eq('first rule target host', compiled.rules[0].targetHost, '198.51.100.1');
eq('first rule groupId', compiled.rules[0].groupId, 'g1');
eq('internal-api deduped from g3 (no duplicate)',
  compiled.rules.filter((r) => r.matchHost === 'internal-api.example.com').length, 1);
eq('other.example.com from g3',
  compiled.rules.some((r) => r.matchHost === 'other.example.com'), true);
eq('api.example.com NOT included (g2 disabled)',
  compiled.rules.some((r) => r.matchHost === 'api.example.com'), false);
eq('good.example.com from g4',
  compiled.rules.some((r) => r.matchHost === 'good.example.com'), true);

console.log('\n== compileActiveRules 防御 ==');
eq('compileActiveRules null safe', compileActiveRules(null).rules.length, 0);
eq('compileActiveRules undefined safe', compileActiveRules(undefined).rules.length, 0);
eq('compileActiveRules empty safe', compileActiveRules([]).rules.length, 0);

console.log('\n== compileActiveRules 端口匹配 (找规则) ==');
const portGroups = [
  { id: 'a', name: 'A', enabled: true, content: '10.0.0.1:443  example.com:443\n10.0.0.2:80  example.com:80' },
];
const portCompiled = compileActiveRules(portGroups);
eq('port distinct: count 2', portCompiled.rules.length, 2);
eq('port distinct: 443', portCompiled.rules.some((r) => r.targetPort === '443' && r.matchPort === '443'), true);
eq('port distinct: 80', portCompiled.rules.some((r) => r.targetPort === '80' && r.matchPort === '80'), true);

const dupGroups = [
  { id: 'a', name: 'A', enabled: true, content: '10.0.0.1  example.com\n10.0.0.2  example.com' },
];
const dupCompiled = compileActiveRules(dupGroups);
eq('dedup: same matchHost no port → 1 rule', dupCompiled.rules.length, 1);
eq('dedup: first wins', dupCompiled.rules[0].targetHost, '10.0.0.1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
