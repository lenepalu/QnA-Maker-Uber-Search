const restify = require('restify');
const builder = require('botbuilder');
const azureStorage = require('azure-storage');
const search = require('azure-search-client');
const ag = require('./lib/AggregateClient');
const qna = require('./lib/QnAContext');
const utils = require('./lib/Utils');
const sp = require('./lib/Spellcheck');

const config = {
    searchName: process.env.SEARH_NAME,
    searchKey: process.env.SEARCH_KEY,
    searchIndexName: process.env.SEARCH_INDEX_NAME,
    storageConnectionString: process.env.BLOB_CONN_STRING,
    lookupTableName: process.env.LOOKUP_TABLE_NAME,
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD,
    qnaMakerEndpoint: "https://westus.api.cognitive.microsoft.com/qnamaker/v2.0/knowledgebases/",
    qnaMakerKey: process.env.QNAMAKER_KEY,
    spellcheckEndpoint: process.env.SPELLCHECK_ENDPOINT,
    spellcheckMode: process.env.SPELLCHECK_MODE,
    spellcheckMkt: process.env.SPELLCHECK_MKT,
    spellcheckKey: process.env.SPELLCHECK_KEY,
    choiceConfidenceDelta: 0.2, //If two items are returned and their scores are within this delta of each other the user is offered a choice. 
    qnaConfidencePrompt: 0.6, //If scores are lower than this users will be offered a choice. 
    qnaMinConfidence: 0.4, //Don't show answers below this level of confidence
    answerUncertainWarning: 0.85, //If scores are lower than this a warning is shown.
    searchConfidence: 0.7
};

const chatConnector = new builder.ChatConnector({
    appId: config.appId,
    appPassword: config.appPassword
});

console.info("Starting with config:");
console.info(config);

const retryPolicy = new azureStorage.ExponentialRetryPolicyFilter();
const tableClient = azureStorage.createTableService(config.storageConnectionString).withFilter(retryPolicy);
tableClient.lookupTableName = config.lookupTableName;

const searchClient = new search.SearchClient(config.searchName, config.searchKey);
searchClient.indexName = config.searchIndexName;

const agClient = new ag.AggregateClient(searchClient, tableClient, config.qnaMakerKey, config.searchConfidence);
const spellcheck = new sp.Spellcheck(config.spellcheckMode, config.spellcheckMkt, config.spellcheckEndpoint, config.spellcheckKey);


let isServerReady = false;
// Setup Restify Server
const server = restify.createServer();
server.get('/healthz', (req, res) => {
    if (isServerReady) {
        res.send(200);
    } else {
        res.send(500);
    }
});

server.listen(process.env.port || process.env.PORT || 3978, function () {
    console.log('%s listening to %s', server.name, server.url);

    //Healthcheck service - can we talk to dependencies?
    searchClient.search(config.searchIndexName, { search: 'Is search available?' }, (err, res) => {
        if (err) {
            console.error("Failed to connect to azure search");
            throw err;
        }

        tableClient.doesTableExist(config.lookupTableName, (err, res) => {
            if (err) {
                console.error("Failed to connect to table storage");
                throw err;
            }
            if (res.exists) {
                isServerReady = true;
                setupServer();
            }
        });
    });
});

function buildResponseMessage(session, response) {
    let attachment =
        new builder.HeroCard(session)
            .title(response.questionMatched)
            .subtitle("@" + response.name)
            .text(response.entity);

    if (response.score < config.answerUncertainWarning) {
        attachment = attachment.buttons([
            builder.CardAction.dialogAction(session, 'FollowupQuestionLowConfidence', null, 'Not the right answer? Click here')
        ])
    }


    var msg = new builder.Message(session);
    msg.attachmentLayout(builder.AttachmentLayout.carousel)
    msg.attachments([attachment]);
    msg.inputHint = "expectingInput";
    return msg;
}


function setupServer() {
    server.post('/api/messages', chatConnector.listen());
    var bot = new builder.UniversalBot(chatConnector);
    // Set up interceptor on all incoming messages (user -> Bot) for spellcheck
    bot.use({
        botbuilder: function (session, next) {
            spellcheck.spellcheckMessage(session, next).then(
                res => {
                    let result = res.corrected;
                    console.log(result);
                    next();
                });
        }
    });
    bot.beginDialogAction('FollowupQuestionLowConfidence', 'FollowupQuestionLowConfidence');
    bot.beginDialogAction('FollowupQuestion', 'FollowupQuestion');
    bot.beginDialogAction('NotFound', 'NotFound');

    bot.dialog('/',
        [
            (session, args) => {
                builder.Prompts.text(session, 'Welcome to QnA bot, you can ask questions and I\'ll look up relevant information for you.');
            },
            (session, results, args) => {
                session.replaceDialog('TopLevelQuestion', results.response);
            }
        ]);

    bot.dialog('TopLevelQuestion',
        [
            (session, args) => {
                let questionAsked = args;
                session.privateConversationData.lastQuestion = questionAsked;
                agClient.searchAndScore(questionAsked).then(
                    res => {
                        if (res.length < 1 || res.score === 0 || res.score < config.qnaMinConfidence) {
                            //TODO: In low confidence scenario office available contexts for user to pick. 
                            session.replaceDialog('NotFound', null);
                        } else {
                            session.privateConversationData.questionContexts = res.contexts;

                            //Todo: Should this be moved into the aggregate client? 
                            // I think potentially this sits better as part of it's concerns. 
                            let options = [];
                            let scoreToBeat = res.contexts[0].score - config.choiceConfidenceDelta;
                            res.contexts.forEach(currentContext => {
                                if (currentContext.score >= scoreToBeat) {
                                    options.push(currentContext);
                                }
                            });

                            if (options.length > 1) {
                                session.replaceDialog('SelectContext', questionAsked);
                            } else {
                                session.privateConversationData.selectedContext = res.contexts[0];
                                builder.Prompts.text(session, buildResponseMessage(session, res.answers[0]));
                            }
                        }
                    },
                    err => {
                        session.send('Sorry I had a problem finding an answer to that question');
                        console.error(err);
                    }
                );
            },
            (session, result, args) => {
                session.privateConversationData.lastQuestion = result.response;
                session.replaceDialog('FollowupQuestion', { question: result.response });
            }
        ]
    );

    bot.dialog('SelectContext', [
        (session, args) => {
            let options = session.privateConversationData.questionContexts.map(x => x.name);
            options.push('None of the above');
            builder.Prompts.choice(
                session,
                'We\'ve found a few options, which is the best fit?', options, { listStyle: builder.ListStyle.button }
            );
        },
        (session, result, args) => {
            if (result.response.index > session.privateConversationData.questionContexts.length - 1) {
                session.replaceDialog('NotFound');
            } else {
                session.privateConversationData.selectedContext = session.privateConversationData.questionContexts[result.response.index];
                session.replaceDialog('FollowupQuestion', { question: session.privateConversationData.lastQuestion });
            }
        }
    ]);

    bot.dialog('NotFound',
        [
            (session, args) => {
                if (session.privateConversationData.selectedContext) {
                    session.replaceDialog('NotFoundWithContext');
                } else {
                    builder.Prompts.text(session, "Sorry we couldn't find any answers to that one, can you reword the question and try again?");
                }

            },
            (session, result, args) => {
                session.replaceDialog('TopLevelQuestion', result.response);
            }
        ]);

    bot.dialog('NotFoundWithContext',
        [
            (session, args) => {
                if (session.privateConversationData.selectedContext) {
                    let options = session.privateConversationData.selectedContext.possibleQuestions.slice(0); //Take a copy otherwise changes get saved to state
                    options.push('None of these are useful');
                    builder.Prompts.choice(
                        session,
                        `I'm sorry we couldn't find a good answer to that one in @${session.privateConversationData.selectedContext.name}. We can answer these, are any of these useful?`, options,
                        { listStyle: builder.ListStyle.button });

                } else {
                    session.replaceDialog('NotFound');
                }
            },
            (session, result, args) => {
                // User didn't find a question that was right 
                
                if (result.response.index > session.privateConversationData.selectedContext.possibleQuestions.length - 1) {
                    session.privateConversationData.selectedContext = null;
                    session.replaceDialog('NotFound');

                } else {
                    session.privateConversationData.lastQuestion = result.response.entity;
                    session.replaceDialog('FollowupQuestion', { question: result.response.entity });

                }
            }
        ]);

    // Check a question against the current qnaMaker Context
    // If this is unable provide a good answer, requery at the top level. 
    bot.dialog('FollowupQuestion',
        [
            (session, args) => {
                let questionAsked = args.question;

                //Handle users selecting to change context for a followup question. 
                if (args.context !== undefined) {
                    session.privateConversationData.selectedContext = args.context;
                }

                // Score using the highest matching context
                let context = qna.QnAContext.fromState(session.privateConversationData.selectedContext);
                context.scoreQuestion(questionAsked).then(
                    res => {
                        let topResult = res[0];
                        if (topResult.score > config.qnaConfidencePrompt) {
                            builder.Prompts.text(session, buildResponseMessage(session, topResult));
                        } else {
                            session.replaceDialog('FollowupQuestionLowConfidence', questionAsked);
                        }
                    },
                    err => {
                        session.send("Sorry I had a problem finding an answer to that question");
                        console.error(err);
                    }
                )
            },
            (session, result, args) => {
                session.privateConversationData.lastQuestion = result.response;
                session.replaceDialog('FollowupQuestion', { question: result.response });
            }
        ]
    );

    // Handle low confidence scenarios
    //  As we're unsure on how to answer this question we use a 2 fold approach
    //
    //  1. We consult the existing question context and related contexts
    //  2. We also requery azure search to see if it returns and new contexts
    //
    // These are then all score and top options presented to the user. 
    bot.dialog('FollowupQuestionLowConfidence', [
        (session, args) => {
            let questionAsked = args;

            if (questionAsked === undefined) {
                questionAsked = session.privateConversationData.lastQuestion;
            }

            //Check for any new contexts that might be relevant.
            agClient.findRelevantQnaDocs(questionAsked).then(
                res => {
                    let currentContext = session.privateConversationData.selectedContext;

                    //Add in the existing contexts that are being tracked. 
                    let contexts = session.privateConversationData.questionContexts.map(x => qna.QnAContext.fromState(x));
                    if (res !== undefined && res.length > 1) {
                        contexts.push(...res);
                    }

                    //TOBO: Does this steadily bloat the contexts over a chat? Yes
                    // What should we do?
                    session.privateConversationData.questionContexts = contexts;

                    //TODO: Deduplicate contexts based on kbid. 

                    agClient.scoreRelevantAnswers(contexts, questionAsked).then(
                        res => {
                            let topResult = res[0];
                            if (topResult === undefined) {
                                session.replaceDialog('NotFound', args);
                            } else {
                                let answers = utils.top(res.filter(x=>x.score > config.qnaMinConfidence), 3);
                                let attachments = [new builder.HeroCard(session)
                                .text(`We've found some answers but we're not sure if they're a good fit, you may have changed topics. We included what you can ask in @${currentContext.name} aswell as some alternatives`)];
                                
                                //If none of these answers are from the current context
                                // offer the user the option to see what he can ask in that context
                                if (answers.filter(x=>x.name === currentContext.name).length < 1){
                                    attachments.push(
                                        new builder.HeroCard(session)
                                        .title("@" + currentContext.name)
                                        .subtitle("No answers found for this area")
                                        .buttons([
                                        builder.CardAction.dialogAction(session, "NotFound", null, "What can I ask?")])
                                    );
                                }
                                
                                attachments.push(...answers.map(x => {
                                    return new builder.HeroCard(session)
                                        .title(x.questionMatched)
                                        .subtitle("@" + x.name)
                                        .buttons([
                                            builder.CardAction.imBack(session, `@${x.name}: ${x.questionMatched}`, `Ask this`)
                                        ])
                                }));

                                var msg = new builder.Message(session);
                                msg.attachmentLayout(builder.AttachmentLayout.list)
                                msg.attachments(attachments);
                                msg.inputHint = "expectingInput";

                                builder.Prompts.text(session, msg);
                            }
                        },
                        err => {
                            session.send("Sorry I had a problem finding an answer to that question");
                            console.error(err);
                            session.endDialog();
                        }
                    )
                },
                err => {
                    session.send("Sorry I had a problem finding an answer to that question");
                    console.error(err);
                    session.endDialog();
                }
            )
        },
        (session, result, args) => {
            let text = result.response;
            if (text.includes('@') && text.includes(':')) {
                let indexOfSeperator = text.indexOf(':');
                let contextName = text.substring(1, indexOfSeperator);
                let question = text.substring(indexOfSeperator + 1);
                let context = session.privateConversationData.questionContexts.filter(x => x.name === contextName)[0];

                session.replaceDialog('FollowupQuestion', { question: question, context: context });

            } else {
                session.privateConversationData.lastQuestion = result.response;
                session.replaceDialog('FollowupQuestion', { question: result.response });
            }
        }
    ])
}
