# Muretto box

Il pannello da ingegnere di pista per lo schermo del MacBook: scegli il tuo pilota e segui
distacchi, gomme, finestra box, punto di rientro, telemetria contro un rivale, radio e direzione gara.

Non serve installare nulla oltre a Node 20 o superiore.

```bash
npm start
```

Poi apri <http://localhost:8420>. Per le prove del modello:

```bash
npm test
```

## Comandi

| Comando | Azione |
| --- | --- |
| Spazio | Avvia o ferma il replay |
| ← e → | Indietro o avanti di 10 s |
| Maiusc + ← e → | Indietro o avanti di 60 s |
| Clic su un pilota in classifica | Lo usa come confronto |
| Clic su un giro nel grafico dei tempi | Apre la telemetria di quel giro |
| Chiama BOX | Registra la tua decisione e la confronta con quella della squadra |

Per seguire un replay insieme al video, porta entrambi allo stesso punto e rifinisci con i tasti freccia.

## In diretta con F1Data

Il muretto legge le registrazioni del live timing che F1Data scrive in
`~/Desktop/F1Data/live_dashboard/recordings` (predefinita) (un'altra cartella con `F1DATA_RECORDINGS`).
Nel menu **Gara** compaiono in alto, sotto *Registrazioni F1Data*.

Il giorno della gara:

1. avvia F1Data e controlla che il pulsante **F1 TV** sia verde: senza accesso mancano
   telemetria e posizioni in pista;
2. avvia il muretto con `npm start` e apri <http://localhost:8420>.

Se F1Data sta registrando una gara, il muretto la apre da solo e segue l'ora reale. Ogni tre
secondi rilegge solo la parte nuova del file. Con i tasti freccia o la barra si torna indietro e
si guarda in differita, per esempio per allinearsi al video di F1 TV che arriva qualche secondo
dopo i tempi; **Torna in diretta** riporta all'ora reale. A sessione finita la registrazione
resta nel menu e si rivede come un replay.

Le registrazioni coprono gare e sprint. Se F1Data si collega a gara iniziata, la partenza e le
gomme montate prima vengono ricostruite dalla cronologia della sessione e dagli anni delle gomme;
i giri precedenti al collegamento mancano.

Per provare tutto prima di un GP, `tools/prova-diretta.mjs` rimanda una registrazione passata
come se fosse in corso adesso (le istruzioni sono in cima al file).

## Da dove arrivano i numeri

Le gare passate arrivano da [OpenF1](https://openf1.org), gratis; il suo tempo reale è a
pagamento, per questo la diretta passa da F1Data. Sul Messico 2026 le due fonti danno gli stessi
tempi sul giro (oltre il 99%), lo stesso ordine d'arrivo e la stessa telemetria. Nelle
registrazioni di F1Data la sosta conta dall'ingresso in corsia box, in OpenF1 dall'uscita, e
manca la durata del pit stop da fermo. La telemetria ha circa 3,7 campioni al secondo, quindi i
confronti di frenata sono indicativi.

Il replay non anticipa mai il futuro: ogni calcolo usa solo ciò che era noto in quell'istante, e un
test lo controlla su una gara reale.

## Stime da tarare

Misurati dai dati: distacchi, degrado, perdita box (dopo almeno 3 soste valide).
Stimati, e modificabili in `ASSUMPTIONS` dentro `public/model.js`:

| Valore | Predefinito |
| --- | --- |
| Guadagno da carburante | 0,05 s/giro |
| Perdita box prima delle prime soste | 24 s |
| Quota della perdita sotto Safety Car | 50% |
| Quota della perdita sotto Virtual SC | 65% |
| Perdita nel giro di uscita | 0,5 s |

Il modello della finestra box usa un degrado lineare e non conosce le differenze di passo tra mescole.

## Setup di MultiViewer a tre schermi

`multiviewer/make-setup.mjs` aggiunge a MultiViewer il setup **Muretto · Top 4**. Legge da solo
come sono disposti gli schermi, quindi va rilanciato solo se li sposti.

| Schermo | Contenuto |
| --- | --- |
| Philips verticale | Onboard in primo piano in alto, poi RUS·ANT, LEC·HAM, VER·HAD, NOR·PIA |
| Philips orizzontale | F1 LIVE a tutto schermo, unico player con l'audio |
| MacBook | Live timing di MultiViewer |

```bash
node multiviewer/make-setup.mjs
```

MultiViewer va chiuso mentre lo lanci. Il file precedente resta in `setups.config.json.bak`.
In MultiViewer apri la sessione e poi il setup: le finestre si agganciano ai flussi tramite numero
e sigla del pilota, quindi lo stesso setup va bene per ogni gara. Per il 2027 aggiorna `TEAMS`
nello script.
