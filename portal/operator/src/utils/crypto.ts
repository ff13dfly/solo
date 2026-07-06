import CryptoJS from 'crypto-js';

// 计算登录哈希 - 与 user 服务一致: SHA256(password + salt)
// 注意: user 服务注册时存储的是 SHA256(password + salt)
export const deriveLoginHash = (password: string, _username: string, salt: string, _iterations: number) => {
    // user 服务使用简单 SHA256，不使用 PBKDF2
    // 参考 api/user/logic/user.js line 127: SHA256(challenge + user.hash)
    // 其中 user.hash = SHA256(password + salt) 在注册时生成
    return CryptoJS.SHA256(password + salt).toString();
};

// 计算挑战响应 - SHA256(challenge + loginHash)
export const computeResponse = (challenge: string, loginHash: string) => {
    return CryptoJS.SHA256(challenge + loginHash).toString();
};
