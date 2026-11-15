import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [
    { title: "Вход — Inverk Clips" }, { name: "description", content: "Вход в приватную студию Inverk Clips." },
    { property: "og:title", content: "Вход — Inverk Clips" }, { property: "og:description", content: "Вход в студию." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Auth,
});

function Auth() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [signup, setSignup] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (user) nav({ to: "/" }); }, [user, nav]);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const r = signup ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }) : await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (r.error) return toast.error(r.error.message);
    if (signup && !r.data.session) toast.success("Проверьте почту и подтвердите адрес");
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={go} className="panel w-full max-w-sm space-y-3 p-6">
        <div className="font-display text-lg font-bold">INVERK<span className="text-primary">·</span>CLIPS</div>
        <p className="text-xs text-muted-foreground">Приватная студия вертикальных роликов</p>
        <Input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input type="password" required minLength={8} placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" className="w-full" disabled={busy}>{signup ? "Создать аккаунт" : "Войти"}</Button>
        <button type="button" onClick={() => setSignup(!signup)} className="w-full text-xs text-muted-foreground hover:text-foreground">{signup ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Регистрация"}</button>
      </form>
    </div>
  );
}
