import { useState, useEffect } from 'react';
import { Delete } from 'lucide-react';
import { cn } from '../../lib/utils';

interface PinPadModalProps {
  isOpen: boolean;
  mode: 'setup' | 'verify'; // 'setup' requires confirm
  onSuccess: (pin: string) => Promise<boolean | void>; // Allow async validation
}

export function PinPadModal({ isOpen, mode, onSuccess }: PinPadModalProps) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [step, setStep] = useState<'enter' | 'confirm'>('enter'); // 'enter' for 1st input, 'confirm' for 2nd
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPin("");
      setConfirmPin("");
      setStep('enter');
      setError(null);
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const handleDigit = (digit: string) => {
    setError(null);
    if (step === 'enter') {
      if (pin.length < 6) {
        const newPin = pin + digit;
        setPin(newPin);
        
        if (newPin.length === 6) {
            handleCompleteStep(newPin, 'enter');
        }
      }
    } else {
      if (confirmPin.length < 6) {
        const newConfirm = confirmPin + digit;
        setConfirmPin(newConfirm);
        
        if (newConfirm.length === 6) {
            handleCompleteStep(newConfirm, 'confirm');
        }
      }
    }
  };

  const handleBackspace = () => {
    setError(null);
    if (step === 'enter') {
      setPin(prev => prev.slice(0, -1));
    } else {
      setConfirmPin(prev => prev.slice(0, -1));
    }
  };

  const handleCompleteStep = async (value: string, currentStep: 'enter' | 'confirm') => {
    if (mode === 'verify') {
        // Just verify
        try {
            const result = await onSuccess(value);
            if (result === false) {
                 setError("PIN 错误，请重试");
                 setTimeout(() => {
                    setPin("");
                    setError(null);
                }, 1000);
            } else {
            }
        } catch (e) {
             setError("验证失败");
             setTimeout(() => {
                setPin("");
                setError(null);
            }, 1000);
        }
    } else {
        // Setup mode
        if (currentStep === 'enter') {
            setTimeout(() => {
                setStep('confirm');
                // Could verify simple rules here (e.g. not 123456)
            }, 300);
        } else {
            // Check match
            if (value === pin) {
                onSuccess(pin);
            } else {
                setError("两次输入不一致，请重试");
                setTimeout(() => {
                    setPin("");
                    setConfirmPin("");
                    setStep('enter');
                    setError(null);
                }, 1000);
            }
        }
    }
  };

  const dots = Array(6).fill(0);
  const currentInput = step === 'enter' ? pin : confirmPin;
  
  let title = "请输入6位数字密码";
  if (mode === 'setup') {
      title = step === 'enter' ? "请设置6位数字密码" : "请再次输入以确认";
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-gray-100 rounded-t-2xl w-full p-4 pb-8 shadow-2xl relative animate-in slide-in-from-bottom duration-300">

        
        <div className="text-center mb-6 mt-2">
          <h2 className="text-lg font-bold text-gray-800 mb-2">{title}</h2>
          {error ? (
              <p className="text-red-500 text-xs h-4">{error}</p>
          ) : (
              <p className="text-gray-500 text-xs h-4">
                  {mode === 'setup' && step === 'enter' ? "用于快速登录和加密数据" : " "}
              </p>
          )}
        </div>

        {/* Dots */}
        <div className="flex justify-center gap-3 mb-6">
          {dots.map((_, i) => (
            <div 
              key={i} 
              className={cn(
                "w-3 h-3 rounded-full transition-all duration-200",
                i < currentInput.length 
                    ? "bg-black scale-110" 
                    : "bg-gray-300 border border-gray-400"
              )}
            />
          ))}
        </div>

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-3 max-w-[220px] mx-auto">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
            <button
              key={num}
              onClick={() => handleDigit(num.toString())}
              className="h-12 rounded-xl bg-white shadow-sm text-xl font-semibold text-gray-900 active:bg-gray-200 transition-colors"
            >
              {num}
            </button>
          ))}
          <div /> {/* Empty */}
          <button
              onClick={() => handleDigit("0")}
              className="h-12 rounded-xl bg-white shadow-sm text-xl font-semibold text-gray-900 active:bg-gray-200 transition-colors"
            >
              0
          </button>
          <button
              onClick={handleBackspace}
              className="h-12 rounded-xl bg-transparent sm:bg-white/50 text-gray-900 flex items-center justify-center active:bg-gray-200 transition-colors"
            >
              <Delete size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
