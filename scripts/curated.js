// Hand-written people. The Wikidata import (scripts/import-wikidata.js) keeps these
// exactly as written here (hint, answers, places) and only adds how famous they are.
// Add people here to write their entry yourself instead of taking it from Wikidata;
// `wikidata` is the person's Wikidata ID (the Q-number in their Wikidata URL).
module.exports = [
  {
    wikidata: "Q937",
    name: "Albert Einstein",
    answers: ["albert einstein"],
    hint: "Physicist and mathematician",
    born: { year: 1879, lat: 48.4011, lng: 10.0348, place: "Ulm, Germany" },
    died: { year: 1955, lat: 40.3487, lng: -74.6591, place: "Princeton, USA" }
  },
  {
    wikidata: "Q762",
    name: "Leonardo da Vinci",
    answers: ["leonardo da vinci", "leonardo di ser piero da vinci"],
    hint: "Renaissance painter and inventor",
    born: { year: 1452, lat: 43.7833, lng: 10.9167, place: "Vinci, Italy" },
    died: { year: 1519, lat: 47.4133, lng: 0.9838, place: "Amboise, France" }
  },
  {
    wikidata: "Q517",
    name: "Napoleon Bonaparte",
    answers: ["napoleon bonaparte", "napoleone buonaparte", "napoleon i"],
    hint: "Military and political leader who crowned himself emperor",
    born: { year: 1769, lat: 41.9192, lng: 8.7386, place: "Ajaccio, Corsica" },
    died: { year: 1821, lat: -15.9339, lng: -5.7167, place: "Longwood, Saint Helena" }
  },
  {
    wikidata: "Q7186",
    name: "Marie Curie",
    answers: ["marie curie", "marie sklodowska curie", "maria sklodowska"],
    hint: "Scientist who pioneered research on radioactivity",
    born: { year: 1867, lat: 52.2297, lng: 21.0122, place: "Warsaw, Poland" },
    died: { year: 1934, lat: 45.9268, lng: 6.7089, place: "Passy, France" }
  },
  {
    wikidata: "Q254",
    name: "Wolfgang Amadeus Mozart",
    answers: ["wolfgang amadeus mozart", "wolfgang mozart", "amadeus mozart"],
    hint: "Composer and child prodigy",
    born: { year: 1756, lat: 47.8095, lng: 13.0550, place: "Salzburg, Austria" },
    died: { year: 1791, lat: 48.2082, lng: 16.3738, place: "Vienna, Austria" }
  },
  {
    wikidata: "Q5582",
    name: "Vincent van Gogh",
    answers: ["vincent van gogh"],
    hint: "Post-Impressionist painter",
    born: { year: 1853, lat: 51.4667, lng: 4.6500, place: "Zundert, Netherlands" },
    died: { year: 1890, lat: 49.0667, lng: 2.1667, place: "Auvers-sur-Oise, France" }
  },
  {
    wikidata: "Q9036",
    name: "Nikola Tesla",
    answers: ["nikola tesla"],
    hint: "Inventor and electrical engineer",
    born: { year: 1856, lat: 44.6167, lng: 15.3167, place: "Smiljan, Croatia" },
    died: { year: 1943, lat: 40.7128, lng: -74.0060, place: "New York City, USA" }
  },
  {
    wikidata: "Q935",
    name: "Isaac Newton",
    answers: ["isaac newton"],
    hint: "Physicist and mathematician known for the laws of motion",
    born: { year: 1643, lat: 52.8055, lng: -0.6297, place: "Woolsthorpe, England" },
    died: { year: 1727, lat: 51.5000, lng: -0.1935, place: "Kensington, England" }
  },
  {
    wikidata: "Q91",
    name: "Abraham Lincoln",
    answers: ["abraham lincoln"],
    hint: "U.S. president during the Civil War",
    born: { year: 1809, lat: 37.5679, lng: -85.7378, place: "Hodgenville, Kentucky" },
    died: { year: 1865, lat: 38.8951, lng: -77.0364, place: "Washington, D.C." }
  },
  {
    wikidata: "Q1001",
    name: "Mahatma Gandhi",
    answers: ["mahatma gandhi", "mohandas gandhi", "mohandas karamchand gandhi", "mahatma ghandi", "mohandas ghandi"],
    hint: "Leader of a nonviolent independence movement",
    born: { year: 1869, lat: 21.6417, lng: 69.6293, place: "Porbandar, India" },
    died: { year: 1948, lat: 28.6139, lng: 77.2090, place: "New Delhi, India" }
  },
  {
    wikidata: "Q255",
    name: "Ludwig van Beethoven",
    answers: ["ludwig van beethoven", "ludwig beethoven"],
    hint: "Composer who kept writing after losing his hearing",
    born: { year: 1770, lat: 50.7374, lng: 7.0982, place: "Bonn, Germany" },
    died: { year: 1827, lat: 48.2082, lng: 16.3738, place: "Vienna, Austria" }
  },
  {
    wikidata: "Q1035",
    name: "Charles Darwin",
    answers: ["charles darwin"],
    hint: "Naturalist known for a theory of evolution",
    born: { year: 1809, lat: 52.7069, lng: -2.7538, place: "Shrewsbury, England" },
    died: { year: 1882, lat: 51.3308, lng: 0.0533, place: "Downe, England" }
  },
  {
    wikidata: "Q7226",
    name: "Joan of Arc",
    answers: ["joan of arc", "jeanne d'arc"],
    hint: "Military leader and religious figure executed in her teens",
    born: { year: 1412, lat: 48.4547, lng: 5.6892, place: "Domremy, France" },
    died: { year: 1431, lat: 49.4431, lng: 1.0993, place: "Rouen, France" }
  },
  {
    wikidata: "Q303",
    name: "Elvis Presley",
    answers: ["elvis presley", "elvis aaron presley"],
    hint: "Musician known as a rock and roll icon",
    born: { year: 1935, lat: 34.2576, lng: -88.7034, place: "Tupelo, Mississippi" },
    died: { year: 1977, lat: 35.1495, lng: -90.0490, place: "Memphis, Tennessee" }
  },
  {
    wikidata: "Q4583",
    name: "Anne Frank",
    answers: ["anne frank", "annelies frank"],
    hint: "Diarist who wrote in hiding during World War II",
    born: { year: 1929, lat: 50.1109, lng: 8.6821, place: "Frankfurt, Germany" },
    died: { year: 1945, lat: 52.7594, lng: 9.9114, place: "Bergen-Belsen, Germany" }
  },
  {
    wikidata: "Q5588",
    name: "Frida Kahlo",
    answers: ["frida kahlo"],
    hint: "Painter known for surreal self-portraits",
    born: { year: 1907, lat: 19.3467, lng: -99.1618, place: "Coyoacan, Mexico City" },
    died: { year: 1954, lat: 19.3550, lng: -99.1580, place: "Coyoacan, Mexico City" }
  }
];
