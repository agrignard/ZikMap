import { createDate, convertDate, showDate, getConversionPatterns} from './import/dateUtilities.mjs';
import * as fs from 'fs';
import { parse, isValid }  from 'date-fns';
import * as cheerio from 'cheerio';
import {parseDocument} from 'htmlparser2';
import {makeURL, simplify} from './import/stringUtilities.mjs';
import {loadLinkedPages, saveToJSON, saveToCSV} from './import/fileUtilities.mjs';
import {samePlace, getAliases, getStyleConversions, loadVenuesJSONFile, writeToLog} from './import/jsonUtilities.mjs';
import { mergeEvents} from './import/mergeUtilities.mjs';

// Chemin vers le fichier à lire
const sourcePath = './webSources/';

//var out="";// = "PLACE,TITRE,UNIX,SIZE,GENRE,URL";
const outFile = "generated/scrapexResult.csv";
const globalDefaultStyle = '';
const styleConversion = getStyleConversions();
const showFullMergeLog = false;


const dateConversionPatterns = getConversionPatterns();
const venueList = loadVenuesJSONFile();
let aliasList = getAliases(venueList);

//const venueNamesList = venues.map(el => el.name);
    
const fileToScrap = process.argv[2];
if (fileToScrap){
  if (venueList.some(element => element.name === fileToScrap)){
    console.log('\x1b[32m%s\x1b[0m', `Traitement uniquement de \'${fileToScrap}\'`);
    const venues = venueList.filter(element => element.name === fileToScrap);
    scrapFiles(venues);
  }else{
    console.log('\x1b[31mFichier \x1b[0m%s.html\x1b[31m non trouvé. Fin du scrapping.\x1b[0m\n', fileToScrap);
  }
}else{
  await scrapFiles(venueList.filter(el => el.hasOwnProperty('eventsDelimiterTag')));
  const venuesToSkip = venueList.filter(el => !el.hasOwnProperty('eventsDelimiterTag')).map(el => el.name+' ('+el.city+', '+el.country+')');
  console.log('\x1b[36mWarning: the following venues have no scraping details and are only used as aliases. Run analex if it is a mistake.\x1b[0m',venuesToSkip);
}



async function scrapFiles(venues) {
  let totalEventList = [];
  for (const venue of venues) {
    let err = false;
    if (!(venue.hasOwnProperty('eventsDelimiterTag') || venue.hasOwnProperty('eventsDelimiterRegex'))){
      console.log('\x1b[31m%s\x1b[0m', 'Aucun délimiteur de bloc d\'événement défini pour '+venue.name);
      err = true;
    }
    if (!venue.hasOwnProperty('scrap') || !(venue.scrap.hasOwnProperty('eventNameTags') || venue.scrap.hasOwnProperty('eventNameRegex'))){
      console.log('\x1b[31m%s\x1b[0m', 'Aucun délimiteur de nom d\'événement défini pour '+venue.name);
      err = true;
    }
    if (!venue.hasOwnProperty('scrap') || !(venue.scrap.hasOwnProperty('eventDateTags') || venue.scrap.hasOwnProperty('eventDateRegex'))){
      console.log('\x1b[31m%s\x1b[0m', 'Aucun délimiteur de date d\'événement défini pour '+venue.name);
      err = true;
    }
    if (!err){
      totalEventList = totalEventList.concat(await analyseFile(venue));
    } else{
      console.log('\x1b[31mEntrée %s non traitée.\x1b[0m', venue.name);
    }
  }
  // merge duplicate events
  console.log('*** Merging duplicate events ***\n');
  //totalEventList = mergeEvents(totalEventList,showFullMergeLog);

  console.log('Scrapex fini avec succex !! (%s events found).\n', totalEventList.length);

  saveToCSV(totalEventList, outFile);
  // save to JSON
  saveToJSON(totalEventList,'./generated/scrapResult.json');

  // save errors to JSON file
  saveToJSON(totalEventList.filter(el => el.hasOwnProperty('errorLog')),'./generated/errorLog.json');


  // save errors to error log
  writeLogFile(totalEventList,'error');
  writeLogFile(totalEventList,'warning');
  console.log('\n');
  
}



async function analyseFile(venue) {
  let linkedFileContent, inputFileList;
  const venueSourcePath = sourcePath+venue.country+'/'+venue.city+'/'+venue.name+'/';
  if (venue.hasOwnProperty('linkedPage')){
    linkedFileContent = loadLinkedPages(venueSourcePath);
  }
  // get file list to scrap
  try {
    inputFileList = fs.readdirSync(venueSourcePath)
      .filter(fileName => fileName.endsWith('.html'))
      .map(el => venueSourcePath+el);
  } catch (err) {
    console.error('\x1b[31mError reading html files in directory \'%s\'.\x1b[0m Error: %s',venueSourcePath, err);
  }

  console.log('\n\x1b[32m%s\x1b[0m', `******* Venue: ${venue.name}  (${inputFileList.length} page(s)) *******`);

  // build event list and analyze the events
  const [eventBlockList, hrefInDelimiterList] = await extractEvents(inputFileList,venue);
  let eventList = analyseEvents(eventBlockList, hrefInDelimiterList, venue);
  eventList = unique(eventList);
  console.log('Found %s events for %s.\n\n',eventList.length,venue.name);
  return eventList;



  function analyseEvents(eventBlockList, hrefInDelimiterList, venue){
    let eventList = [];
    const dateFormat = (venue.hasOwnProperty('linkedPage') && venue.linkedPage.hasOwnProperty('eventDateTags'))?venue.linkedPageDateFormat:venue.dateFormat; 

    // parsing each event
    try{
      eventBlockList.forEach((eve,eveIndex) =>{
        let $eventBlock = cheerio.load(eve);
        let eventInfo = {'eventPlace':venue.name};
        
        // changing to default style if no style
        // eventInfo.eventStyle = venue.hasOwnProperty('defaultStyle')?venue.defaultStyle:globalDefaultStyle;

        // **** event data extraction ****/
        Object.keys(venue.scrap).forEach(key => eventInfo[key.replace('Tags','')] = getText(key,venue.scrap,$eventBlock));


        //extract URL
        let eventURL;
        try{
          if (!venue.scrap.hasOwnProperty('eventURLTags')){
            if (venue.hasOwnProperty('eventURLIndex') && venue.eventURLIndex === -1){
              eventURL =venue.baseURL;
            }else{
              let index = venue.hasOwnProperty('eventURLIndex')?venue.eventURLIndex:0;
              if (index == 0){// the URL is in A href
                  //     eventURL = makeURL(venue.baseURL,$(venue.eventsDelimiterTag+':eq('+eveIndex+')').attr('href'));
                  eventURL = makeURL(venue.baseURL,hrefInDelimiterList[eveIndex]);
              }else{// URL is in inner tags
                  index = index - 1;
                const tagsWithHref = $eventBlock('a[href]');
                eventURL = makeURL(venue.baseURL,$eventBlock(tagsWithHref[index]).attr('href'));
              }
            }
          }else{ // if a delimiter for the URL has been defined
            eventURL = makeURL(venue.baseURL,$eventBlock(venue.scrap.eventURLTags[0]).attr('href'));
            eventInfo.eventURL = eventURL;
          }
        }catch(err){
          writeToLog('error',eventInfo,["\x1b[31mErreur lors de la récupération de l\'URL.\x1b[0m",err],true);
        }

        if (!isEmptyEvent(eventInfo)){
          // scrap info from linked page
          if (linkedFileContent){
            try{
              const $linkedBlock = cheerio.load(linkedFileContent[eventURL]);
              Object.keys(venue.linkedPage).forEach(key => eventInfo[key.replace('Tags','')] = getText(key,venue.linkedPage,$linkedBlock));  
            }catch{
              writeToLog('error',eventInfo,['\x1b[31mImpossible de lire la page liée pour l\'événement \'%s\'. Erreur lors du téléchargement ?\x1b[0m', eventInfo.eventName],true);
            }
            // if the url in the linked is empty, replace by the main page one
            if (!eventInfo.hasOwnProperty('eventURL') || eventInfo.eventURL === undefined || eventInfo.eventURL.length === 0){
              eventInfo.eventURL = eventURL;
            }
          }else{
            eventInfo.eventURL = eventURL;
          }

          //*** post processing, show logs and save  ***//

          // perform regexp
          if (venue.hasOwnProperty('regexp')){
            applyRegexp(eventInfo,venue.regexp);
          }
      
          // match event place with existing one
          if (venue.scrap.hasOwnProperty('eventPlaceTags') || (venue.hasOwnProperty('linkedPage') && venue.linkedPage.hasOwnProperty('eventPlaceTags'))){
            eventInfo.eventPlace = FindLocationFromAlias(eventInfo.eventPlace,venue.country,venue.city,aliasList);
          }

          // get normalized style
          eventInfo.eventDetailedStyle = eventInfo.hasOwnProperty('eventStyle')?eventInfo.eventStyle:'';
          if (!eventInfo.hasOwnProperty('eventStyle') || eventInfo.eventStyle ===''){
            const eventPlace = venueList.find(el => samePlace(el,{name:eventInfo.eventPlace, city: venue.city, country:venue.country}));
            if (eventPlace && eventPlace.hasOwnProperty('defaultStyle')){
              eventInfo.eventStyle = eventPlace.defaultStyle;
            }else{
              eventInfo.eventStyle = globalDefaultStyle;
            }
          }
          eventInfo.eventStyle = getStyle(eventInfo.eventStyle);
          eventInfo.source = {'name':venue.name, 'city':venue.city, 'country':venue.country};

          // make a list of events in case of multidate
          const eventInfoList = createMultiEvents(eventInfo);
         
          
          eventInfoList.forEach(el => {
            // change the date format to Unix time
            let formatedEventDate = createDate(el.eventDate,dateFormat,dateConversionPatterns);
           // el.date = formatedEventDate;
            if (!isValid(formatedEventDate)){
              writeToLog('error',el,['\x1b[31mFormat de date invalide pour %s. Reçu \"%s\", converti en \"%s\" (attendu \"%s\")\x1b[0m', 
                venue.name,el.eventDate,convertDate(el.eventDate,dateConversionPatterns),dateFormat],true);
              el.unixDate = 0;
            }else{
              // changer 00:00 en 23:59 si besoin
              if (venue.hasOwnProperty('midnightHour')){
                formatedEventDate = changeMidnightHour(formatedEventDate,venue.midnightHour,el);
              }
              el.unixDate = formatedEventDate.getTime();
              console.log(showDate(formatedEventDate));
            }


            // display
            displayEventLog(el);
            eventList.push(el);
          });
         
        }
      }); 
      
    }catch(error){
      console.log("Unknown error while processing "+venue.name,error);
    }
    return eventList;
  }
}
  


//********************************************/
//***            aux functions             ***/
//********************************************/


     // auxiliary function to extract data
     function getText(tagName,JSONblock,source){
      let string = "";
      const tagList = JSONblock[tagName];
      if (tagName !== 'eventMultiDateTags'){
        try{
          for (let i = 0; i <= tagList.length-1; i++) {
            let ev = tagList[i]===''?source.text():source(tagList[i]).text();
            string += ev+' ';
          }
        }catch(err){
          console.log('\x1b[31m%s\x1b[0m', 'Erreur d\'extraction à partir des balises.\x1b[0m',tagList);
        }
        return removeBlanks(string);
      }else{
        const res = source(tagList[0]).map((index, element) => source(element).text()).get();
        return res;
      }
     
      //return tagName === 'eventPlaceTags'?fixString(removeBlanks(string),venueNamesList):removeBlanks(string);
    }
    // end of auxiliary function




function removeBlanks(s){
  return s.replace(/[\n\t]/g, ' ').replace(/ {2,}/g, ' ').replace(/^[ ]{1,}/,'').replace(/[ ]{1,}$/,'');
}



async function extractEvents(inputFileList, venue){
  let eventBlockList = [];
  let hrefInDelimiterList = [];
  const promise = inputFileList.map(async inputFile =>{
    try{
      const venueContent = await fs.promises.readFile(inputFile, 'utf8');
      const $ = cheerio.load(parseDocument(venueContent));
      try{
        $(venue.eventsDelimiterTag).each((index, element) => {
          let ev = $(element).html();
          eventBlockList.push(ev);
          hrefInDelimiterList.push($(venue.eventsDelimiterTag+':eq('+index+')').attr('href'));
      });     
      }catch(err){        
        console.log('\x1b[31m%s\x1b[0m. %s', 'Délimiteur mal défini pour '+venue.name,err);      
      }
    }catch (err){
      console.error("\x1b[31mErreur lors de la lecture du fichier local: \'%s\'.\x1b[0m %s",inputFile, (err.code==='ENOENT')?'':err);
    }
  });
  await Promise.all(promise);
  return [eventBlockList, hrefInDelimiterList];
}


function unique(list) {
  const uniqueSet = new Set(list.map(obj => JSON.stringify(obj)));
  return Array.from(uniqueSet).map(str => JSON.parse(str));
};





function FindLocationFromAlias(string,country,city,aliasList){
  let res = string;
  aliasList.filter(venue => venue.country === country && venue.city === city)
  .forEach(venue => {
    if (venue.aliases.filter(al => simplify(al) === simplify(string)).length > 0){// if the name of the place of the event is in the alias list, replace by the main venue name
      res = venue.name;
    }
  });
  return res;
}

function getStyle(string){
  const stringComp = simplify(string);
  let res = string;
  Object.keys(styleConversion).forEach(style =>{
    if (styleConversion[style].some(word => stringComp.includes(word))){
      res = style;
    }
  });
  return res;
}

function  displayEventLog(eventInfo){
  console.log('Event : %s (%s, %s)',eventInfo.eventName,eventInfo.source.city,eventInfo.source.country);
  Object.keys(eventInfo).forEach(key => {
      if (!['eventName', 'eventDate', 'eventURL', 'unixDate', 'eventDummy', 'source','city','country'].includes(key)){
        console.log(key.replace('event',''),': ',eventInfo[key.replace('Tags','')]);
    }
  });
  console.log((eventInfo.eventURL)+'\n');
}

function  displayEventFullDetails(eventInfo){
  let string = 'Date: '+eventInfo.eventDate+'\n';
  string = string+'Event: '+eventInfo.eventName+'\n';
  Object.keys(eventInfo).forEach(key => {
      if (!['eventName', 'eventDate', 'eventURL'].includes(key)){
        string = string+(key.replace('event','')+': '+eventInfo[key.replace('Tags','')])+'\n';
    }
  });
  string = string +eventInfo.eventURL+'\n\n';
  return string;
}


function isEmptyEvent(eventInfo){
  return eventInfo.eventName === '' && (eventInfo.eventURL === '' || eventInfo.eventURL == undefined) && eventInfo.eventDate === '';
}



function createMultiEvents(eventInfo){
  if (eventInfo.hasOwnProperty('eventMultiDate')){
    if (eventInfo.eventMultiDate.length >0){
    const res = [];
    eventInfo.eventMultiDate.forEach(el =>{
      const ei = {...eventInfo};
      ei.eventDate = el;
      delete ei.eventMultiDate;
      res.push(ei);
    });
    return res;
    }else{
      delete eventInfo.eventMultiDate;
      return [eventInfo];
    }
  }else{
    return checkMultiDates(eventInfo);
  }
}

function checkMultiDates(eventInfo){
  if (eventInfo.eventDate.includes('et')){
    const r1 = /([^]*?)à([^]*?)et([^]*?)$/;
    if (r1.test(eventInfo.eventDate)){
      const m = eventInfo.eventDate.match(r1);
      const d1 = m[1]+'à'+m[2];
      const d2 = m[1]+'à'+m[3];
      const e1 = {...eventInfo};
      e1.eventDate = d1;
      const e2 = {...eventInfo};
      e2.eventDate = d2;
      return [e1, e2];
    }
    const r2 = /([^]*?)et([^]*?)à([^]*?),[^]*?à([^]*?)$/;
    if (r2.test(eventInfo.eventDate)){
      const m = eventInfo.eventDate.match(r2);
      const year = new Date().getFullYear();
      const d1 = m[1]+year+' à'+m[3];
      const d2 = m[2]+year+' à'+m[4];
      const e1 = {...eventInfo};
      e1.eventDate = d1;
      const e2 = {...eventInfo};
      e2.eventDate = d2;
      return [e1, e2];
      //eventInfo.errorLog = "CONVERSION "+d1;
    }
  }
  return [eventInfo];
}


function applyRegexp(event, rulesSet){
  Object.keys(rulesSet).forEach(key =>{
    if (typeof rulesSet[key] === 'string'){// a string, regexp is used for a match
      event[key] = event[key].match(new RegExp(rulesSet[key]));
    }else if (rulesSet[key].length === 2){// a list of two elements. replace pattern (1st) with (2nd)
      event[key] = event[key].replace(new RegExp(rulesSet[key][0]),rulesSet[key][1]);
    }
  });
}


function changeMidnightHour(date,targetDay,eventInfo){
  let newDate = date;
  if (newDate.getHours() === 0 && newDate.getMinutes() === 0) {
    newDate.setHours(23);
    newDate.setMinutes(59);
  }
  if (simplify(targetDay) === 'sameday'){
    // do nothing
  }else if (simplify(targetDay) === 'previousday'){// set to previous day
    newDate.setTime(date.getTime() - 86400000);
  }else{
    writeToLog('error',eventInfo,['\x1b[31mMidnight date string invalid. Received %s, should be \'sameDay\' or \'previousDay\'.\x1b[0m',targetDay],true);  
  }
  return newDate;
}


export function writeLogFile(eventList,type){
  const colorTag = type==='error'?'\x1b[31m':'\x1b[36m';
  const key = type+'Log';
  const list = eventList.filter(el => el.hasOwnProperty(key));
  const nbEntries = list.length;
  if (nbEntries > 0){
    console.log("\x1b[0mFound %s%s\x1b[0m events with %s%ss\x1b[0m, check \'%s.log\' for details.\x1b[0m",
            colorTag,nbEntries,colorTag,type,type);
  }

  let log = '';
  list.forEach(el =>{
    log = log + displayEventFullDetails(el);
  });
  fs.writeFile('./'+type+'.log', log, 'utf8', (err) => {
    if (err) {
      console.error("\x1b[31mCannot write error log file:\x1b[0m %s", err);
    }
  });
}