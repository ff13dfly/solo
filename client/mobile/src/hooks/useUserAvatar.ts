import { useState, useRef } from 'react';
import { compressImage } from '../lib/imageUtils';

export function useUserAvatar() {
    const [userAvatar, setUserAvatar] = useState(() => localStorage.getItem("user_avatar_base64") || "");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleAvatarClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        try {
            const compressedBase64 = await compressImage(file, 200, 0.7);
            setUserAvatar(compressedBase64);
            localStorage.setItem("user_avatar_base64", compressedBase64);
        } catch (error) {
            console.error("Failed to process image", error);
            // alert("图片处理失败，请重试");
        }
        
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    return {
        userAvatar,
        fileInputRef,
        handleAvatarClick,
        handleFileChange
    };
}
