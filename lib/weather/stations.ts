/**
 * VECTA station to official MET Malaysia forecast location (district-level "Ds" ids of https://api.data.gov.my/weather/forecast, verified against the live
 * feed on 2026-11-03). The forecast is for the DISTRICT the airport lies in, not for the airfield. KUL - MAA and KUL - AAX share Sepang.
 */
export interface ForecastLocation {
  id: string;
  name: string;
}

export const STATION_FORECAST_LOCATION: Record<string, ForecastLocation> = {
  "KUL - MAA": { id: "Ds064", name: "Sepang" },
  "KUL - AAX": { id: "Ds064", name: "Sepang" },
  AOR: { id: "Ds004", name: "Kota Setar" },
  BKI: { id: "Ds554", name: "Kota Kinabalu" },
  BTU: { id: "Ds531", name: "Bintulu" },
  JHB: { id: "Ds088", name: "Kulai" },
  KBR: { id: "Ds024", name: "Kota Bharu" },
  KCH: { id: "Ds504", name: "Kuching" },
  LBU: { id: "Ds578", name: "Labuan" },
  LGK: { id: "Ds001", name: "Langkawi" },
  MYY: { id: "Ds537", name: "Miri" },
  PEN: { id: "Ds011", name: "Barat Daya" },
  SBW: { id: "Ds521", name: "Sibu" },
  SDK: { id: "Ds565", name: "Sandakan" },
  TGG: { id: "Ds046", name: "Kuala Nerus" },
  TWU: { id: "Ds552", name: "Tawau" },
  KUA: { id: "Ds069", name: "Kuantan" },
  IPH: { id: "Ds032", name: "Kinta" },
  MKZ: { id: "Ds078", name: "Melaka Tengah" },
  SZB: { id: "Ds057", name: "Petaling" },
};

export function forecastLocationFor(station: string | null | undefined): ForecastLocation | null {
  if (!station) return null;
  return Object.prototype.hasOwnProperty.call(STATION_FORECAST_LOCATION, station) ? STATION_FORECAST_LOCATION[station] : null;
}
