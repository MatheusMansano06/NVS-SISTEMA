import { useState } from 'react';
import type { z } from 'zod';
import { ApiError } from '../../shared/http';

type Errors = Record<string, string | undefined>;

/** Estado de formulário com validação pelos mesmos schemas Zod usados no backend. */
export function useForm<V extends Record<string, string | boolean>>(initial: V) {
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof V>(key: K) => (value: V[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key as string]: undefined }));
    setFormError('');
  };

  function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> | null {
    const r = schema.safeParse(data);
    if (r.success) return r.data;
    const next: Errors = {};
    for (const issue of r.error.issues) next[String(issue.path[0] ?? '_')] ??= issue.message;
    setErrors(next);
    return null;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFormError('');
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError) {
        const fields: Errors = {};
        for (const [k, msgs] of Object.entries(err.fieldErrors)) fields[k] = msgs[0];
        setErrors(fields);
        setFormError(Object.keys(fields).length ? '' : err.message);
      } else {
        setFormError('Algo deu errado. Tente novamente.');
      }
    } finally {
      setBusy(false);
    }
  }

  const setFieldError = (key: keyof V, message: string) =>
    setErrors((e) => ({ ...e, [key as string]: message }));

  return { values, errors, formError, busy, set, validate, run, setFieldError };
}
