import { useState, useEffect } from 'react';
import { Delete, X, Check } from 'lucide-react';


interface FocusInputModalProps {
  isOpen: boolean;
  field: string;
  label?: string;
  type: string;
  initialValue?: any;
  onClose: () => void;
  onSubmit: (value: any) => void;
}

export function FocusInputModal({ isOpen, field, label, type, initialValue, onClose, onSubmit }: FocusInputModalProps) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue ? String(initialValue) : "");
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  const isNumeric = type === 'number' || type === 'integer';

  const handleDigit = (digit: string) => {
    setValue(prev => {
        if (digit === '.' && prev.includes('.')) return prev;
        return prev + digit;
    });
  };

  const handleBackspace = () => {
    setValue(prev => prev.slice(0, -1));
  };

  const handleSubmit = () => {
    const finalValue = isNumeric ? Number(value) : value;
    onSubmit(finalValue);
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className="bg-white rounded-t-3xl w-full p-6 pb-12 shadow-2xl relative animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">输入{label || field}</h2>
          <button onClick={onClose} className="p-1.5 bg-gray-100 rounded-full text-gray-500 active:bg-gray-200 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Display Area */}
        <div className="mb-4 p-3 bg-gray-50 rounded-xl border-2 border-gray-100 focus-within:border-blue-500 transition-all">
          {isNumeric ? (
            <div className="h-8 flex items-center justify-end text-2xl font-bold text-gray-900 tracking-tight">
              {value || <span className="text-gray-300">0</span>}
            </div>
          ) : (
            <input
              autoFocus
              className="w-full bg-transparent text-lg font-medium text-gray-900 outline-none"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="请输入..."
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
          )}
        </div>

        {/* Input Controls */}
        {isNumeric ? (
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button
                key={num}
                onClick={() => handleDigit(num.toString())}
                className="h-10 rounded-xl bg-gray-50 text-xl font-bold text-gray-800 active:bg-gray-200 active:scale-95 transition-all shadow-sm"
              >
                {num}
              </button>
            ))}
            <button
                onClick={() => handleDigit(".")}
                className="h-10 rounded-xl bg-gray-50 text-xl font-bold text-gray-800 active:bg-gray-200 active:scale-95 transition-all shadow-sm"
              >
                .
            </button>
            <button
                onClick={() => handleDigit("0")}
                className="h-10 rounded-xl bg-gray-50 text-xl font-bold text-gray-800 active:bg-gray-200 active:scale-95 transition-all shadow-sm"
              >
                0
            </button>
            <button
                onClick={handleBackspace}
                className="h-10 rounded-xl bg-gray-50 text-gray-800 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all shadow-sm"
              >
                <Delete size={20} />
            </button>
            
            <button
              onClick={handleSubmit}
              className="col-span-3 mt-2 h-12 rounded-xl bg-blue-600 text-white text-lg font-bold flex items-center justify-center gap-2 active:bg-blue-700 active:scale-[0.98] transition-all shadow-lg shadow-blue-200"
            >
              <Check size={20} /> 确认
            </button>
          </div>
        ) : (
          <button
            onClick={handleSubmit}
            className="w-full h-12 rounded-xl bg-blue-600 text-white text-lg font-bold flex items-center justify-center gap-2 active:bg-blue-700 active:scale-[0.98] transition-all shadow-lg shadow-blue-200"
          >
            <Check size={20} /> 确认
          </button>
        )}
      </div>
    </div>
  );
}
