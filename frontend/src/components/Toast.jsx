import { useState, useEffect } from 'react';

export function useToast() {
  const [message, setMessage] = useState(null);

  const showToast = (msg, duration = 3500) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), duration);
  };

  return { message, showToast };
}

export function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="toast-container">
      <div className="toast-msg">{message}</div>
    </div>
  );
}
