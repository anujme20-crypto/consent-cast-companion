import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VoiceLink — Live voice, two phones" },
      {
        name: "description",
        content:
          "Consent-based live voice link: speak from the admin panel and be heard instantly on the paired target phone.",
      },
      { property: "og:title", content: "VoiceLink — Live voice, two phones" },
      {
        property: "og:description",
        content:
          "Consent-based live voice link: speak from the admin panel and be heard instantly on the paired target phone.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary text-3xl">
          <span aria-hidden>🎙️</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">VoiceLink</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Speak on the admin phone — the paired target phone hears you live,
          automatically. Consent-based: the target phone pairs itself with a
          code first.
        </p>
        <div className="mt-8 grid gap-3">
          <Card className="text-left">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Admin panel phone</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Sign in, share the pairing code, then start speaking.
              </p>
              <Button asChild className="w-full">
                <Link to="/admin">Open admin panel</Link>
              </Button>
            </CardContent>
          </Card>
          <Card className="text-left">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Target phone</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Pair once with the admin's code — calls then answer by
                themselves.
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link to="/device">Set up target phone</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
