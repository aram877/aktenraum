import { Component } from "@angular/core";
import { RouterLink } from "@angular/router";

interface HomeCard {
  readonly to: string;
  readonly eyebrow: string;
  readonly eyebrowAccent: boolean;
  readonly title: string;
  readonly description: string;
}

@Component({
  selector: "app-home",
  imports: [RouterLink],
  templateUrl: "./home.html",
})
export class Home {
  protected readonly cards: readonly HomeCard[] = [
    {
      to: "/ask",
      eyebrow: "KI-Assistent",
      eyebrowAccent: true,
      title: "Ask AI →",
      description: "Stelle Fragen zu deinen Dokumenten in natürlicher Sprache.",
    },
    {
      to: "/scan",
      eyebrow: "Scannen",
      eyebrowAccent: false,
      title: "Dokument scannen →",
      description: "Mit der Kamera erfassen — direkt als PDF ablegen.",
    },
    {
      to: "/library",
      eyebrow: "Archiv",
      eyebrowAccent: false,
      title: "Bibliothek →",
      description: "Alle klassifizierten Dokumente durchsuchen.",
    },
    {
      to: "/upload",
      eyebrow: "Eingang",
      eyebrowAccent: false,
      title: "+ Hochladen",
      description: "PDF oder Bild hochladen — KI klassifiziert automatisch.",
    },
  ];
}
