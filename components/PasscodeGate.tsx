'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Stethoscope } from 'lucide-react';

const PASSCODE = '112679';
const STORAGE_KEY = 'cr_auth';

export function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [shaking, setShaking] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    // sessionStorage isn't available during SSR, so this read MUST happen in an
    // effect — matches the React docs' "synchronize with external system" pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sessionStorage.getItem(STORAGE_KEY) === 'true') setAuthenticated(true);
    setHydrated(true);
  }, []);

  const validate = useCallback((code: string[]) => {
    const entered = code.join('');
    if (entered.length !== 6) return;
    if (entered === PASSCODE) {
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setAuthenticated(true);
    } else {
      setShaking(true);
      setTimeout(() => {
        setShaking(false);
        setDigits(Array(6).fill(''));
        inputRefs.current[0]?.focus();
      }, 500);
    }
  }, []);

  const handleChange = useCallback((index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const digit = value.slice(-1);
    setDigits(prev => {
      const next = [...prev];
      next[index] = digit;
      if (digit && index < 5) {
        inputRefs.current[index + 1]?.focus();
      }
      if (next.every(d => d !== '')) {
        setTimeout(() => validate(next), 0);
      }
      return next;
    });
  }, [validate]);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [digits]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    const next = Array(6).fill('');
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setDigits(next);
    const focusIndex = Math.min(pasted.length, 5);
    inputRefs.current[focusIndex]?.focus();
    if (next.every(d => d !== '')) {
      setTimeout(() => validate(next), 0);
    }
  }, [validate]);

  if (!hydrated) return null;
  if (authenticated) return <>{children}</>;

  return (
    <div className="min-h-screen gradient-hero flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 max-w-sm w-full">
        {/* Branding */}
        <div className="flex flex-col items-center gap-3">
          <div className="p-3 bg-primary/10 rounded-xl">
            <Stethoscope className="size-8 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
            ClinicalRounds
          </h1>
          <p className="text-sm text-muted-foreground">Enter access code to continue</p>
        </div>

        {/* Digit inputs */}
        <div
          className={`flex gap-2.5 ${shaking ? 'animate-shake' : ''}`}
          onPaste={handlePaste}
        >
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={el => { inputRefs.current[i] = el; }}
              type="tel"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={e => handleChange(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              className={`w-12 h-14 text-2xl font-mono text-center rounded-lg border-2 bg-card outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 ${
                shaking ? 'border-destructive' : 'border-border'
              }`}
              aria-label={`Digit ${i + 1}`}
              autoFocus={i === 0}
            />
          ))}
        </div>

        {/* Disclaimer */}
        <p className="text-[11px] text-muted-foreground text-center leading-relaxed max-w-xs">
          AI clinical reasoning aid. Does not replace physician clinical judgment.
          Not for diagnostic or treatment decisions.
        </p>
      </div>
    </div>
  );
}
