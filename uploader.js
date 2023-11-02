require("dotenv").config();
const csv = require("csv-parser");
const fs = require("fs");
const { Client } = require("@notionhq/client");
const notion = new Client({
  auth: process.env.NOTION_KEY
});
const waitTime = 400;
const applicationStatus = new Map([
  ["bookmarked", "Not started"],
  ["applying", "Not started"],
  ["applied", "Applied"],
  ["interviewing", "Interviewing"],
  ["negotiating", "Interviewing"],
  ["accepted", "Accepted"]
]);

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function normalizeValue(header, value) {
  switch (header) {
    // Splits locations into string array
    case "locations":
      new_value = [];
      const locations = value.split("|");
      for (let location of locations) {
        const loc = location.replaceAll(",", "").trim();
        if (loc !== "") {
          new_value.push(loc);
        }
      }
      value = new_value;
      break;

    // Converts date (MM/DD/YYYY) to ISO 8601 (YYYY-MM-DD)
    case "date_saved":
    case "date_applied":
      if (!value) {
        break;
      }
      const [month, day, year] = value.split("/");
      const date = new Date(year, month - 1, day);
      value = date.toISOString().split("T")[0];
      break;
  }

  return value;
}

async function lookupRecord(record, databaseId) {
  const filter = {
    and: [
      {
        property: "Company",
        rich_text: {
          contains: record.company
        },
      },
      {
        property: "Role",
        rich_text: {
          contains: record.role
        }
      }
    ]
  };

  if (Array.isArray(record.locations) && record.locations.length > 0) {
    filter.and.push({
      property: "Location",
      multi_select: {
        contains: record.locations[0]
      }
    });
  }

  if (record.date_applied !== "") {
    filter.and.push({
      property: "Date Applied",
      date: {
        equals: record.date_applied
      }
    });
  }

  const response = await notion.databases.query({
    database_id: databaseId,
    filter: filter
  });

  return response.results.length > 0 ? response.results[0] : null;
}

async function updatePage(record, pageId) {
  return notion.pages.update({
    page_id: pageId,
    properties: {
      "Status": {
        status: {
          name: applicationStatus.get(record.status)
        }
      },
      "Last Action Date": {
        date: {
          start: new Date().toISOString()
        }
      }
    }
  });
}

function arrayToMultiSelectOptions(arr) {
  const objs = [];
  for (let item of arr) {
    objs.push({ name: item });
  }
  return objs;
}

function getWorkEnvironment(locations) {
  for (let location of locations) {
    if (location.toLowerCase().includes("hybrid")) {
      return "Hybrid";
    }
    if (location.toLowerCase().includes("remote")) {
      return "Remote";
    }
  }
  return "Office";
}

function createPageObject(record, databaseId) {
  const pageObject = {
    parent: {
      type: "database_id",
        database_id: databaseId
    },
    properties: {
      "Company": {
        title: [
          {text: { content: record.company }}
        ]
      },
      "Role": {
        rich_text: [
          {text: { content: record.role }}
        ]
      },
      "Status": {
        status: {
          name: applicationStatus.get(record.status)
        }
      },
      "Work Environment": {
        select: {
          name: getWorkEnvironment(record.locations)
        }
      },
      "To Do / Other Notes": {
        rich_text: []
      },
      "Last Action Date": {
        date: {
          start: new Date().toISOString()
        }
      },
      "URL": {
        url: null
      }
    }
  };

  if (record.date_applied !== "") {
    pageObject.properties["Date Applied"] = {
      date: {
        start: record.date_applied
      }
    };
  }

  if (Array.isArray(record.locations) && record.locations.length > 0) {
    pageObject.properties["Location"] = {
      multi_select: arrayToMultiSelectOptions(record.locations)
    };
  }

  return pageObject;
}

(async () => {
  const records = [];
  const filename = process.argv[2];
  const headers = {
    "Company": "company",
    "Job Position": "role",
    "Max. Salary": "salary",
    "Location": "locations",
    "Status": "status",
    "Date saved": "date_saved",
    "Date applied": "date_applied"
  };

  let skipCount = 0;
  let updateCount = 0;
  let uploadCount = 0;

  fs.createReadStream(filename)
    .pipe(csv({
      mapHeaders: ({ header, index }) => {
        return (header in headers) ? headers[header] : null;
      },
      mapValues: ({ header, index, value }) => {
        return normalizeValue(header, value);
      }
    }))
    .on("data", (record) => records.push(record))
    .on("end", async () => {
      try {
        const databaseId = process.env.NOTION_DATABASE_ID;
        for (let record of records) {
          console.log(record);
          
          // Skips records not applied yet
          if (applicationStatus.get(record.status) === "Not started") {
            console.log("Skipped (not applied)\n");
            continue;
          }

          const onlineRecord = await lookupRecord(record, databaseId);
          if (onlineRecord) {
            console.log("Record exists");
            await sleep(waitTime);
            
            // Updates if status has changed
            if (applicationStatus.get(record.status) !== onlineRecord.properties.Status.status.name) {
              const response = await updatePage(record, onlineRecord.id);
              console.log("Status updated\n");
              updateCount++;
              await sleep(waitTime);
            } else {
              console.log("Skipped\n");
              skipCount++;
            }
            continue;
          }

          // Creates a new page
          const response = await notion.pages.create(createPageObject(record, databaseId));
          console.log("Record uploaded\n");
          uploadCount++;
          await sleep(waitTime);
        }
      } catch (error) {
        console.error(error);
      }

      console.log("=====================");
      console.log(`New records: ${uploadCount}`);
      console.log(`Updated records: ${updateCount}`);
      console.log(`Skipped records: ${skipCount}`);
      console.log(`Total records: ${uploadCount + updateCount + skipCount}`);
      console.log("=====================");
    });
})();
