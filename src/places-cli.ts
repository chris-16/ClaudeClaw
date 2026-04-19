#!/usr/bin/env node

/**
 * places-cli.ts
 *
 * CLI tool to manage known places for location tracking.
 *
 * Usage:
 *   node dist/places-cli.js list
 *   node dist/places-cli.js add <name> <lat> <lon> [--radius 100] [--type home|work|gym|etc] [--city Santiago]
 *   node dist/places-cli.js delete <id>
 */

import { deletePlace, getPlace, getPlaces, initDatabase, upsertPlace } from './db.js';

initDatabase();

function showHelp(): void {
  console.log(`
Places CLI - Manage known locations for semantic location tracking

Usage:
  places-cli list                                    List all places
  places-cli add <name> <lat> <lon> [options]       Add or update a place
  places-cli get <id>                                Get details of a place
  places-cli delete <id>                             Delete a place

Options for 'add':
  --radius <meters>     Radius in meters (default: 100)
  --type <type>         Place type (home, work, gym, hotel, restaurant, etc.)
  --city <city>         City name
  --country <country>   Country name

Examples:
  places-cli list
  places-cli add "Home" -33.4489 -70.6693 --radius 150 --type home --city Santiago
  places-cli add "Gym" 10.4862 -66.8569 --radius 100 --type gym --city Caracas
  places-cli delete hotel-eurobuilding
`);
}

function listPlaces(): void {
  const places = getPlaces();

  if (places.length === 0) {
    console.log('No places configured yet.');
    return;
  }

  console.log('\nKnown places:\n');
  for (const place of places) {
    const location = `${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}`;
    const details = [
      place.radius ? `${place.radius}m radius` : null,
      place.type,
      place.city,
      place.country,
    ]
      .filter(Boolean)
      .join(', ');

    console.log(`  ${place.name} (${place.id})`);
    console.log(`    Location: ${location}`);
    if (details) console.log(`    Details: ${details}`);
    console.log();
  }
}

function addPlace(args: string[]): void {
  if (args.length < 3) {
    console.error('Error: Missing required arguments: name, lat, lon');
    showHelp();
    process.exit(1);
  }

  const name = args[0];
  const lat = parseFloat(args[1]);
  const lon = parseFloat(args[2]);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    console.error('Error: Invalid coordinates');
    process.exit(1);
  }

  // Parse options
  let radius = 100;
  let type: string | undefined;
  let city: string | undefined;
  let country: string | undefined;

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--radius' && args[i + 1]) {
      radius = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--type' && args[i + 1]) {
      type = args[i + 1];
      i++;
    } else if (args[i] === '--city' && args[i + 1]) {
      city = args[i + 1];
      i++;
    } else if (args[i] === '--country' && args[i + 1]) {
      country = args[i + 1];
      i++;
    }
  }

  // Generate ID from name
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  upsertPlace({
    id,
    name,
    lat,
    lon,
    radius,
    type,
    city,
    country,
  });

  console.log(`✓ Place "${name}" added/updated (${id})`);
  console.log(`  Location: ${lat}, ${lon}`);
  console.log(`  Radius: ${radius}m`);
  if (type) console.log(`  Type: ${type}`);
  if (city) console.log(`  City: ${city}`);
  if (country) console.log(`  Country: ${country}`);
}

function getPlaceDetails(id: string): void {
  const place = getPlace(id);

  if (!place) {
    console.error(`Error: Place "${id}" not found`);
    process.exit(1);
  }

  console.log(`\nPlace: ${place.name} (${place.id})`);
  console.log(`  Location: ${place.lat}, ${place.lon}`);
  console.log(`  Radius: ${place.radius}m`);
  if (place.type) console.log(`  Type: ${place.type}`);
  if (place.city) console.log(`  City: ${place.city}`);
  if (place.country) console.log(`  Country: ${place.country}`);
  if (place.metadata) console.log(`  Metadata: ${place.metadata}`);
  console.log(`  Created: ${new Date(place.created_at * 1000).toISOString()}`);
  console.log(`  Updated: ${new Date(place.updated_at * 1000).toISOString()}`);
  console.log();
}

function deletePlaceById(id: string): void {
  const success = deletePlace(id);

  if (success) {
    console.log(`✓ Place "${id}" deleted`);
  } else {
    console.error(`Error: Place "${id}" not found`);
    process.exit(1);
  }
}

// Main
const [, , command, ...args] = process.argv;

switch (command) {
  case 'list':
    listPlaces();
    break;
  case 'add':
    addPlace(args);
    break;
  case 'get':
    if (args.length === 0) {
      console.error('Error: Missing place ID');
      showHelp();
      process.exit(1);
    }
    getPlaceDetails(args[0]);
    break;
  case 'delete':
    if (args.length === 0) {
      console.error('Error: Missing place ID');
      showHelp();
      process.exit(1);
    }
    deletePlaceById(args[0]);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    console.error(`Error: Unknown command "${command}"`);
    showHelp();
    process.exit(1);
}
