import CryptoJS from 'crypto-js';

// 计算登录哈希 (这一步的结果即为"私钥", 注册时提交此值, 登录时用此值签名)
export const deriveLoginHash = (password: string, username: string, salt: string, iterations: number) => {
    const key = password + username; // 注意: 用户名作为密钥的一部分
    const saltWords = CryptoJS.enc.Hex.parse(salt);
    
    const hash = CryptoJS.PBKDF2(key, saltWords, {
        keySize: 256 / 32,
        iterations: iterations,
        hasher: CryptoJS.algo.SHA256
    });
    
    return hash.toString();
};

// 计算挑战响应
export const computeResponse = (challenge: string, loginHash: string) => {
    return CryptoJS.SHA256(challenge + loginHash).toString();
};

export const generateSalt = () => {
    return CryptoJS.lib.WordArray.random(128 / 8).toString();
};
