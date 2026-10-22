# Poolstation voor Homey

Homey Pro-app voor zwembadregelingen die verbinden met het [Poolstation](https://poolstation.net)-platform, zoals zoutelektrolyse- en pH-regelaars van Fluidra-merken (Idegis, AstralPool). Je ziet watertemperatuur, pH, redox, chloor en zout in Homey, schakelt relais (pomp, licht) en past streefwaarden aan vanuit flows.

Port van de [Home Assistant Poolstation-integratie](https://github.com/cibernox/homeassistant-poolstation) en de bibliotheek [pypoolstation](https://pypi.org/project/pypoolstation/) van Miguel Camba (MIT).

## Installeren

```bash
npm install
npm run images     # maakt de PNG-afbeeldingen die Homey nodig heeft
homey app install  # of: homey app run
```

## Koppelen

Voeg een apparaat **Zwembad** toe en log in met het e-mailadres en wachtwoord van je Poolstation-account. Staat inloggen met een inlogcode (tweestapsverificatie) aan, dan vraagt de app daarna om de code uit je e-mail. Elk zwembad in het account wordt een apparaat.

Alle zwembaden delen één login. Net als de Home Assistant-integratie bewaart de app je e-mailadres en wachtwoord in de app-instellingen op je Homey, zodat een verlopen sessie automatisch wordt vernieuwd. Met tweestapsverificatie kan dat niet; het apparaat wordt dan onbeschikbaar met de melding om te repareren. Kies **Repareren** en log opnieuw in.

## Apparaat: Zwembad

Het apparaat krijgt alleen de waarden die je regelaar echt meldt. Een zwembad zonder redox- of UV-module krijgt die tegels dus niet.

| Waarde | Capability | Opmerking |
|---|---|---|
| Watertemperatuur | `measure_temperature` | °C |
| pH, gewenste pH | `pool_ph`, `pool_target_ph` | instelbaar 6,0 – 8,0 |
| Redox (ORP), gewenste redox | `pool_orp`, `pool_target_orp` | mV, instelbaar 600 – 850 |
| Vrij chloor, gewenst chloor | `pool_chlorine`, `pool_target_chlorine` | ppm, instelbaar 0,30 – 3,50 |
| Zout | `pool_salt` | g/l |
| Elektrolyse, gewenste productie | `pool_electrolysis`, `pool_target_production` | %, instelbaar 0 – 100 |
| Relais | `onoff.relay_<id>` | aan/uit, met de naam uit Poolstation |
| Waterstroomprobleem | `alarm_generic.flow` | |
| Digitale ingangen 1–4 | `pool_input.d1` … `d4` | met de naam uit Poolstation |
| UV-lamp aan, ingeschakeld, beschikbaar | `pool_uv_on`, `pool_uv_enabled`, `pool_uv_available` | |
| UV-lampuren, totaal | `pool_uv_timer`, `pool_uv_total` | |
| Storing UV-voorschakelapparaat, UV-zekering | `alarm_generic.uv_ballast`, `alarm_generic.uv_fuse` | |

Nieuwe relais en hernoemde relais of ingangen in Poolstation worden automatisch overgenomen. De waarden worden standaard elke 60 seconden opgehaald (instelbaar, minimaal 30). Na een wijziging vanuit Homey negeert de app de cloud 45 seconden voor die waarde, zodat de schakelaar niet even terugspringt.

**Triggers:** relais ging aan/uit · digitale ingang ging aan/uit · waterstroomprobleem begonnen/opgelost · pH, redox of chloor veranderd. Temperatuur gebruikt de standaardkaart van Homey.

**Condities:** relais is aan · digitale ingang is aan · er is een waterstroomprobleem.

**Acties:** relais aan/uit/omzetten · gewenste pH, redox, chloor of productie instellen · zwembadwaarden verversen.

## Verschillen met de Home Assistant-integratie

- Streefwaarden (redox, chloor) krijgt een apparaat alleen als de regelaar ze meldt; in Home Assistant bestaan die entiteiten altijd.
- Na een mislukte schrijfactie blijft de oude waarde staan en zie je een foutmelding.
- Bij een storing van Poolstation blijven de laatste waarden staan; na drie mislukte pogingen op rij toont het apparaat een waarschuwing.

## Ontwikkeling

```bash
npm test                         # unit tests (API, parsing)
homey app validate --level publish
```

`lib/PoolstationApi.js` is de API-client: inloggen (met inlogcode), de versleutelde `Authorization`/`Q`-headers, zwembaden ophalen en waarden schrijven via `saveSign`. `lib/pool.js` zet de ruwe API-waarden om naar Homey-capabilities, precies volgens `pypoolstation`.

## Licentie

MIT. Gebaseerd op het werk van Miguel Camba (Home Assistant-integratie en pypoolstation, MIT).
