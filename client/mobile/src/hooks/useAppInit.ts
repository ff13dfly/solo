import { useState, useEffect } from 'react';
import type { Message } from '../types';
import { isMobile } from '../lib/device';

interface UseAppInitProps {
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setSavedAccountName: (name: string) => void;
    setShowPinLogin: (show: boolean) => void;
}

export function useAppInit({ setMessages, setSavedAccountName, setShowPinLogin }: UseAppInitProps) {
    const [isMobileDevice, setIsMobileDevice] = useState(true);

    useEffect(() => {
        if (!isMobile()) {
            setIsMobileDevice(false);
        }
    }, []);

    useEffect(() => {
        const userProfile = localStorage.getItem("chat_user_profile");
        if (!userProfile) {
            // Not registered: Show only registration hint
            setMessages([]);

            setTimeout(() => {
                const noInfoMsg: Message = {
                    id: Date.now().toString(),
                    type: "text",
                    content: "检测到您尚未注册，为了更好的体验，请先完善个人信息 👇",
                    sender: "system",
                    timestamp: Date.now(),
                };
                
                const regDialogMsg: Message = {
                    id: (Date.now() + 1).toString(),
                    type: "edit_dialog",
                    content: "点击填写注册信息",
                    sender: "system",
                    timestamp: Date.now() + 1,
                    payload: {
                        title: "用户登录/注册",
                        buttonText: "开始使用",
                        fields: [] 
                    }
                };

                setMessages([noInfoMsg, regDialogMsg]);
            }, 500);
        } else {
            // Registered: Direct PIN Login
            const profile = JSON.parse(userProfile);
            setSavedAccountName(profile.name || '已保存账号');
            setShowPinLogin(true);
        }
    }, []);

    return { isMobileDevice };
}
