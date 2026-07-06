const crypto = require('crypto');

const password = 'MMzzImUNmy7gMMa';
const username = 'admin';
const salt = '82f37fd14558c3741652aa2d4dcf88fd';
const iterations = 200000;

const loginHash = crypto.pbkdf2Sync(
    password + username,
    Buffer.from(salt, 'hex'),
    iterations,
    32,
    'sha256'
).toString('hex');

console.log('Generated Hash:', loginHash);
console.log('Expected Hash: ', '28cd1ad9bc77b57f0d8fa92729e4c73eb21a65e04c8283c0373efe78891719ed');
console.log('Match:', loginHash === '28cd1ad9bc77b57f0d8fa92729e4c73eb21a65e04c8283c0373efe78891719ed');
